#!/usr/bin/env node

/**
 * DINOv2-small feature extractor for the AI-vs-real probe.
 *
 * Preprocess: shortest edge 256 -> center crop 224, ImageNet mean/std
 * (matches Xenova/dinov2-small preprocessor_config.json). Features are
 * CLS + mean of patch tokens, concatenated (768-d for ViT-S/14).
 *
 * --augment applies a web-realistic degradation (random JPEG quality /
 * downscale) to a random ~60% of images, so the probe learns
 * CDN-mangled inputs too. Use for TRAINING data only, never for eval.
 *
 * Usage:
 *   node eval/extract-features.mjs <image-dir> <model.onnx> <out-prefix> [--augment] [--limit=N]
 *
 * Writes <out-prefix>.bin (float32 rows) and <out-prefix>.jsonl (meta).
 */

import { readdir, readFile, appendFile, access, stat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { RawImage } from '@huggingface/transformers';
import sharp from 'sharp';
import ort from 'onnxruntime-node';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
const AI_DIR_NAMES = new Set(['ai', 'fake', 'generated', 'synthetic']);
const REAL_DIR_NAMES = new Set(['real', 'authentic', 'photo', 'natural']);

const DINO_SHORTEST = 256;
const DINO_CROP = 224;
const DINO_MEAN = [0.485, 0.456, 0.406];
const DINO_STD = [0.229, 0.224, 0.225];

function parseArgs(argv) {
  const positional = [];
  let augment = false;
  let limit = Infinity;
  for (const arg of argv) {
    if (arg === '--augment') augment = true;
    else if (arg.startsWith('--limit=')) limit = Number(arg.slice('--limit='.length));
    else positional.push(arg);
  }
  const [dir, model, outPrefix] = positional;
  if (!dir || !model || !outPrefix) {
    console.error('Usage: node eval/extract-features.mjs <image-dir> <model.onnx> <out-prefix> [--augment] [--limit=N]');
    process.exit(1);
  }
  return { dir, model, outPrefix, augment, limit };
}

async function walkLabeled(dir, parentLabel = null) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      const name = ent.name.toLowerCase();
      let label = parentLabel;
      if (AI_DIR_NAMES.has(name)) label = 'ai';
      else if (REAL_DIR_NAMES.has(name)) label = 'real';
      files.push(...(await walkLabeled(full, label)));
    } else if (IMAGE_EXT.has(extname(ent.name).toLowerCase())) {
      files.push({ path: full, label: parentLabel });
    }
  }
  return files;
}

/** Deterministic per-file PRNG so resumed runs augment identically. */
function seededRandom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 100000) / 100000;
  };
}

/** Web-realistic degradation: JPEG requality and/or downscale. */
async function degradeBytes(buffer, rand) {
  const roll = rand();
  if (roll < 0.4) return { buffer, aug: 'none' };

  let img = sharp(buffer);
  const meta = await img.metadata();
  const shortest = Math.min(meta.width || 0, meta.height || 0);
  const parts = [];

  if (roll < 0.75 && shortest > 400) {
    const target = 320 + Math.floor(rand() * 480);
    if (target < shortest) {
      const scale = target / shortest;
      img = img.resize(Math.round((meta.width || 0) * scale), Math.round((meta.height || 0) * scale));
      parts.push(`resize${target}`);
    }
  }

  const quality = 55 + Math.floor(rand() * 38);
  parts.push(`jpeg${quality}`);
  const outBuf = await img.jpeg({ quality }).toBuffer();
  return { buffer: outBuf, aug: parts.join('+') };
}

// Preprocess comes from the shipped module so probe training, the Node
// harness, and the extension all compute identical DINO inputs (Pillow-
// exact resize, guarded grayscale handling). A local duplicate here once
// drifted from production; do not reintroduce one.
import { dinoPreprocessRawImage as dinoPreprocess } from '../src/dino.js';
export { dinoPreprocess };

/** CLS + mean(patch tokens) from last_hidden_state [1, T, H]. */
export function poolFeatures(hidden, tokens, hiddenSize) {
  const out = new Float32Array(2 * hiddenSize);
  for (let h = 0; h < hiddenSize; h++) out[h] = hidden[h];
  for (let t = 1; t < tokens; t++) {
    const base = t * hiddenSize;
    for (let h = 0; h < hiddenSize; h++) out[hiddenSize + h] += hidden[base + h];
  }
  const n = tokens - 1;
  for (let h = 0; h < hiddenSize; h++) out[hiddenSize + h] /= n;
  return out;
}

async function loadDoneCount(outPrefix) {
  try {
    await access(`${outPrefix}.jsonl`);
  } catch {
    return { done: new Set(), rows: 0 };
  }
  const text = await readFile(`${outPrefix}.jsonl`, 'utf8');
  const done = new Set();
  let rows = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      done.add(rec.file);
      if (!rec.error) rows++;
    } catch {
      // torn line
    }
  }
  return { done, rows };
}

async function main() {
  const { dir, model, outPrefix, augment, limit } = parseArgs(process.argv.slice(2));

  const session = await ort.InferenceSession.create(model, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
  });

  const files = (await walkLabeled(dir)).filter((f) => f.label);
  const { done, rows } = await loadDoneCount(outPrefix);
  const todo = files.filter((f) => !done.has(f.path)).slice(0, limit);
  console.error(`${files.length} images, ${done.size} done (${rows} rows), ${todo.length} to go`);

  let count = 0;
  const t0 = Date.now();

  for (const { path, label } of todo) {
    try {
      let buffer = await readFile(path);
      let aug = 'none';
      if (augment) {
        const rand = seededRandom(basename(path));
        const res = await degradeBytes(buffer, rand);
        buffer = res.buffer;
        aug = res.aug;
      }

      const rawImage = (await RawImage.fromBlob(new Blob([buffer]))).rgb();
      const chw = await dinoPreprocess(rawImage);
      const input = new ort.Tensor('float32', chw, [1, 3, DINO_CROP, DINO_CROP]);
      const outputs = await session.run({ pixel_values: input });
      const hiddenState = outputs.last_hidden_state;
      const [, tokens, hiddenSize] = hiddenState.dims;
      const feat = poolFeatures(hiddenState.data, tokens, hiddenSize);

      await appendFile(`${outPrefix}.bin.part`, Buffer.from(feat.buffer));
      await appendFile(
        `${outPrefix}.jsonl`,
        JSON.stringify({ file: path, label, source: basename(path).split('-')[0], aug, dims: feat.length }) + '\n'
      );
    } catch (err) {
      await appendFile(`${outPrefix}.jsonl`, JSON.stringify({ file: path, label, error: String(err?.message || err) }) + '\n');
    }
    count++;
    if (count % 200 === 0) {
      console.error(`${count}/${todo.length} (${(count / ((Date.now() - t0) / 1000)).toFixed(1)} img/s)`);
    }
  }

  // Finalize: .bin.part holds rows in jsonl (non-error) order.
  const { rows: totalRows } = await loadDoneCount(outPrefix);
  try {
    const partStat = await stat(`${outPrefix}.bin.part`);
    console.error(`done: ${count} new, ${totalRows} total rows, bin bytes=${partStat.size}`);
  } catch {
    console.error(`done: ${count} new, ${totalRows} total rows`);
  }
  await session.release();
}

const isMain = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]));
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
