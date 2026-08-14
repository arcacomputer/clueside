#!/usr/bin/env node

/**
 * All-views sweep scorer: runs every TTA view (440 center/corners + 512
 * center) with no early exit and dumps one JSON line per image. Policy
 * simulation happens offline in eval/analyze.mjs, so one expensive
 * inference pass supports every band/threshold/aggregation question.
 *
 * Uses onnxruntime-node (native CPU) for throughput; parity with the
 * onnxruntime-web product path is fp32-level (validate with
 * eval/harness.mjs on a sample if in doubt).
 *
 * Usage:
 *   node eval/sweep.mjs <image-dir> <out.jsonl> [--limit=N]
 *
 * <image-dir> uses the same ai/ real/ folder-label convention as
 * eval/harness.mjs. Files already present in <out.jsonl> are skipped,
 * so an interrupted sweep resumes.
 */

import { readdir, readFile, appendFile, access } from 'node:fs/promises';
import { join, extname, basename, dirname } from 'node:path';
import { RawImage } from '@huggingface/transformers';
import ort from 'onnxruntime-node';
import { fileURLToPath } from 'node:url';
import { analyzeHeuristics } from '../src/heuristics.js';
import { preprocessRawImageViews } from '../src/clip-preprocess.js';
import { CROP_SIZE, MODEL_ID, MODEL_ONNX_PATH, ONNX_INPUT_NAME, ONNX_OUTPUT_NAME } from '../src/models.js';
import { sigmoid } from '../src/scoring.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const AI_DIR_NAMES = new Set(['ai', 'fake', 'generated', 'synthetic']);
const REAL_DIR_NAMES = new Set(['real', 'authentic', 'photo', 'natural']);

function parseArgs(argv) {
  let dir = '';
  let out = '';
  let limit = Infinity;
  for (const arg of argv) {
    if (arg.startsWith('--limit=')) limit = Number(arg.slice('--limit='.length));
    else if (!dir) dir = arg;
    else if (!out) out = arg;
  }
  if (!dir || !out) {
    console.error('Usage: node eval/sweep.mjs <image-dir> <out.jsonl> [--limit=N]');
    process.exit(1);
  }
  return { dir, out, limit };
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

function sourceOf(file) {
  const m = basename(file).match(/^([a-z0-9]+)-/i);
  return m ? m[1] : 'unknown';
}

async function loadDone(out) {
  try {
    await access(out);
  } catch {
    return new Set();
  }
  const text = await readFile(out, 'utf8');
  const done = new Set();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      done.add(JSON.parse(line).file);
    } catch {
      // ignore torn last line
    }
  }
  return done;
}

async function main() {
  const { dir, out, limit } = parseArgs(process.argv.slice(2));

  const modelPath = join(ROOT, 'models', MODEL_ID, MODEL_ONNX_PATH);
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
  });

  const files = (await walkLabeled(dir)).filter((f) => f.label);
  const done = await loadDone(out);
  const todo = files.filter((f) => !done.has(f.path)).slice(0, limit);
  console.error(`${files.length} labeled images, ${done.size} already scored, ${todo.length} to go`);

  let count = 0;
  const t0 = Date.now();

  for (const { path, label } of todo) {
    try {
      const buffer = await readFile(path);
      const heuristics = await analyzeHeuristics(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), path);
      const rawImage = await RawImage.read(path);
      const views = await preprocessRawImageViews(rawImage);

      const scores = {};
      for (const view of views) {
        const input = new ort.Tensor('float32', view.chw, [1, 3, CROP_SIZE, CROP_SIZE]);
        const outputs = await session.run({ [ONNX_INPUT_NAME]: input });
        scores[view.name] = sigmoid(Number(outputs[ONNX_OUTPUT_NAME].data[0]));
      }

      const record = {
        file: path,
        label,
        source: sourceOf(path),
        width: rawImage.width,
        height: rawImage.height,
        views: scores,
        heur: {
          c2pa: heuristics.c2paAi,
          meta: heuristics.metadataAi,
          url: heuristics.urlHint,
          freq: heuristics.freqResidualVote,
        },
      };
      await appendFile(out, JSON.stringify(record) + '\n');
    } catch (err) {
      await appendFile(out, JSON.stringify({ file: path, label, source: sourceOf(path), error: String(err?.message || err) }) + '\n');
    }

    count++;
    if (count % 25 === 0) {
      const rate = count / ((Date.now() - t0) / 1000);
      console.error(`${count}/${todo.length} (${rate.toFixed(2)} img/s)`);
    }
  }

  console.error(`Done: ${count} scored in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${out}`);
  await session.release();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
