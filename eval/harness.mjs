#!/usr/bin/env node

import { readdir, readFile, access } from 'node:fs/promises';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, pipeline } from '@huggingface/transformers';
import { analyzeHeuristics, neuralPAiFromClassification } from '../src/heuristics.js';
import { fuseScores, DEFAULT_THRESHOLD, isAiAtThreshold } from '../src/fuse.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const MODEL_ID = 'onnx-community/ai-source-detector-ONNX';
const MODEL_ONNX = join(ROOT, 'models', MODEL_ID, 'onnx', 'model_quantized.onnx');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const AI_DIR_NAMES = new Set(['ai', 'fake', 'generated', 'synthetic']);
const REAL_DIR_NAMES = new Set(['real', 'authentic', 'photo', 'natural']);

let classifier = null;

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureClassifier() {
  if (classifier) return classifier;

  if (!(await fileExists(MODEL_ONNX))) {
    throw new Error(
      `Model weights missing at ${MODEL_ONNX}. Run: npm run fetch-model`
    );
  }

  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = join(ROOT, 'models');

  classifier = await pipeline('image-classification', MODEL_ID, {
    dtype: 'q8',
  });

  return classifier;
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

async function neuralScoreForFile(pipe, filePath, buffer) {
  const outputs = await pipe(filePath);
  return neuralPAiFromClassification(outputs);
}

async function scoreFile(pipe, filePath, label) {
  const buffer = await readFile(filePath);
  const heuristics = await analyzeHeuristics(buffer, filePath);
  const neuralPAi = await neuralScoreForFile(pipe, filePath, buffer);
  const fused = fuseScores(neuralPAi, heuristics, DEFAULT_THRESHOLD);
  const predictedAi = isAiAtThreshold(fused.rawScore, DEFAULT_THRESHOLD);

  return {
    file: filePath,
    label,
    raw_score: fused.rawScore,
    neural_score: fused.neuralScore,
    verdict: fused.verdict,
    predicted_ai: predictedAi,
    reasons: fused.reasons.join('; '),
  };
}

function balancedAccuracy(rows) {
  const labeled = rows.filter((r) => r.label === 'ai' || r.label === 'real');
  if (!labeled.length) return null;

  const aiRows = labeled.filter((r) => r.label === 'ai');
  const realRows = labeled.filter((r) => r.label === 'real');
  if (!aiRows.length || !realRows.length) return null;

  const tpr = aiRows.filter((r) => r.predicted_ai).length / aiRows.length;
  const tnr = realRows.filter((r) => !r.predicted_ai).length / realRows.length;
  return (tpr + tnr) / 2;
}

async function main() {
  const dir = resolve(process.argv[2] || '');
  if (!dir) {
    console.error('Usage: npm run eval -- <image-directory>');
    console.error('');
    console.error('Point at a folder with labeled subdirectories, for example:');
    console.error('  dataset/real/*.jpg');
    console.error('  dataset/ai/*.png');
    console.error('');
    console.error('Supported AI folder names: ai, fake, generated, synthetic');
    console.error('Supported real folder names: real, authentic, photo, natural');
    process.exit(1);
  }

  const pipe = await ensureClassifier();
  const files = await walkLabeled(dir);
  if (!files.length) {
    console.error(`No images found under ${dir}`);
    process.exit(1);
  }

  console.log('file,label,raw_score,neural_score,verdict,predicted_ai,reasons');

  const rows = [];
  for (const { path, label } of files) {
    const row = await scoreFile(pipe, path, label);
    rows.push(row);
    console.log(
      `${row.file},${row.label || ''},${row.raw_score.toFixed(4)},${row.neural_score.toFixed(4)},${row.verdict},${row.predicted_ai},"${row.reasons}"`
    );
  }

  const ba = balancedAccuracy(rows);
  const labeledCount = rows.filter((r) => r.label === 'ai' || r.label === 'real').length;

  console.log('');
  console.log(`Scored ${rows.length} image(s), ${labeledCount} with folder labels.`);
  console.log(`Threshold: raw p(AI) >= ${DEFAULT_THRESHOLD} (no remapping).`);

  if (ba === null) {
    console.log(
      'Balanced accuracy: n/a (need both ai/ and real/ subfolders with images).'
    );
  } else {
    console.log(`Balanced accuracy @ ${DEFAULT_THRESHOLD}: ${(ba * 100).toFixed(2)}%`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
