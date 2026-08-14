#!/usr/bin/env node

/**
 * Diagnostic DINO probe scorer over center plus four 224 crops. This tests
 * whether low-CF DINO rescues remain stable across nearby views instead of
 * trusting one saturated center score.
 *
 * Usage: node eval/dino-view-bench.mjs <labeled-dir> <out.jsonl>
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RawImage } from '@huggingface/transformers';
import ort from 'onnxruntime-node';
import {
  DINO_CROP_SIZE,
  DINO_INPUT_NAME,
  DINO_MODEL_ID,
  DINO_ONNX_PATH,
  DINO_OUTPUT_NAME,
  dinoPackedRgbToCHW,
  dinoResizeDimensions,
  dinoScoreHiddenState,
} from '../src/dino.js';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const AI_DIR_NAMES = new Set(['ai', 'fake', 'generated', 'synthetic']);
const REAL_DIR_NAMES = new Set(['real', 'authentic', 'photo', 'natural']);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const [dirArg, outArg] = process.argv.slice(2);
if (!dirArg || !outArg) {
  console.error('Usage: node eval/dino-view-bench.mjs <labeled-dir> <out.jsonl>');
  process.exit(1);
}
const dir = resolve(dirArg);
const out = resolve(outArg);

async function walkLabeled(path, parentLabel = null) {
  const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const files = [];
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) {
      const name = entry.name.toLowerCase();
      let label = parentLabel;
      if (AI_DIR_NAMES.has(name)) label = 'ai';
      else if (REAL_DIR_NAMES.has(name)) label = 'real';
      files.push(...(await walkLabeled(full, label)));
    } else if (IMAGE_EXT.has(extname(entry.name).toLowerCase()) && parentLabel) {
      files.push({ path: full, label: parentLabel });
    }
  }
  return files;
}

function cropPlan(width, height) {
  const maxX = width - DINO_CROP_SIZE;
  const maxY = height - DINO_CROP_SIZE;
  const centerX = Math.floor(maxX / 2);
  const centerY = Math.floor(maxY / 2);
  const candidates = [
    { name: 'center', x: centerX, y: centerY },
    { name: 'tl', x: 0, y: 0 },
    { name: 'tr', x: maxX, y: 0 },
    { name: 'bl', x: 0, y: maxY },
    { name: 'br', x: maxX, y: maxY },
  ];
  const seen = new Set();
  return candidates.filter((view) => {
    const key = `${view.x},${view.y}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function preprocessViews(rawImage) {
  const { width, height } = dinoResizeDimensions(rawImage.width, rawImage.height);
  const resized = await rawImage.resize(width, height);
  const views = [];
  for (const view of cropPlan(width, height)) {
    const cropped = await resized.crop([
      view.x,
      view.y,
      view.x + DINO_CROP_SIZE - 1,
      view.y + DINO_CROP_SIZE - 1,
    ]);
    views.push({
      name: view.name,
      chw: dinoPackedRgbToCHW(cropped.data, cropped.channels),
    });
  }
  return views;
}

const probe = JSON.parse(await readFile(join(ROOT, 'models/probe/dino-probe.json'), 'utf8'));
const modelPath = join(ROOT, 'models', DINO_MODEL_ID, DINO_ONNX_PATH);
const session = await ort.InferenceSession.create(modelPath, {
  executionProviders: ['cpu'],
  graphOptimizationLevel: 'all',
});

const files = await walkLabeled(dir);
const rows = [];
let completed = 0;
for (const file of files) {
  try {
    const rawImage = await RawImage.read(file.path);
    const scores = {};
    for (const view of await preprocessViews(rawImage)) {
      const input = new ort.Tensor(
        'float32',
        view.chw,
        [1, 3, DINO_CROP_SIZE, DINO_CROP_SIZE]
      );
      const outputs = await session.run({ [DINO_INPUT_NAME]: input });
      scores[view.name] = dinoScoreHiddenState(outputs[DINO_OUTPUT_NAME], probe);
    }
    rows.push({
      file: file.path,
      relative: relative(dir, file.path),
      label: file.label,
      source: basename(file.path).split('-')[0],
      scores,
    });
  } catch (error) {
    rows.push({
      file: file.path,
      relative: relative(dir, file.path),
      label: file.label,
      error: error?.message || String(error),
    });
  }
  completed += 1;
  if (completed % 100 === 0) console.error(`${completed}/${files.length}`);
}

await session.release();
await writeFile(out, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
console.log(`${rows.length} rows -> ${out}`);
