#!/usr/bin/env node

import { readdir, readFile, access } from 'node:fs/promises';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, pipeline } from '@huggingface/transformers';
import { analyzeHeuristics } from '../src/heuristics.js';
import { fuseScores, DEFAULT_THRESHOLD, isAiAtThreshold } from '../src/fuse.js';
import {
  neuralPAiFromSourceDetector,
  legacyOneMinusReal,
} from '../src/scoring.js';
import { SOURCE_MODEL_ID } from '../src/models.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const AI_DIR_NAMES = new Set(['ai', 'fake', 'generated', 'synthetic']);
const REAL_DIR_NAMES = new Set(['real', 'authentic', 'photo', 'natural']);

let sourceClassifier = null;

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureClassifier() {
  if (sourceClassifier) return sourceClassifier;

  const sourceOnnx = join(ROOT, 'models', SOURCE_MODEL_ID, 'onnx', 'model_quantized.onnx');
  if (!(await fileExists(sourceOnnx))) {
    throw new Error('Model weights missing. Run: npm run fetch-model');
  }

  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = join(ROOT, 'models');

  sourceClassifier = await pipeline('image-classification', SOURCE_MODEL_ID, { dtype: 'q8' });
  return sourceClassifier;
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

function balancedAccuracy(rows) {
  const labeled = rows.filter((r) => r.label === 'ai' || r.label === 'real');
  if (!labeled.length) return null;

  const aiRows = labeled.filter((r) => r.label === 'ai');
  const realRows = labeled.filter((r) => r.label === 'real');
  if (!aiRows.length || !realRows.length) return null;

  const tpr = aiRows.filter((r) => r.predicted_ai).length / aiRows.length;
  const tnr = realRows.filter((r) => !r.predicted_ai).length / realRows.length;
  return { balanced: (tpr + tnr) / 2, tpr, tnr, ai: aiRows.length, real: realRows.length };
}

async function main() {
  const dir = resolve(process.argv[2] || '');
  const compareLegacy = process.argv.includes('--compare-legacy');

  if (!dir) {
    console.error('Usage: npm run eval -- <image-directory> [--compare-legacy]');
    console.error('');
    console.error('Example layout:');
    console.error('  my-fixture/real/cat.jpg');
    console.error('  my-fixture/ai/pluto.png');
    process.exit(1);
  }

  const pipe = await ensureClassifier();
  const files = await walkLabeled(dir);
  if (!files.length) {
    console.error(`No images found under ${dir}`);
    process.exit(1);
  }

  if (compareLegacy) {
    console.log('file,label,legacy_1_minus_real,new_top_ai_head,legacy_pred,new_pred');
  } else {
    console.log('file,label,raw_score,neural_score,verdict,predicted_ai,reasons');
  }

  const rows = [];
  const legacyRows = [];

  for (const { path, label } of files) {
    const buffer = await readFile(path);
    const outputs = await pipe(path);
    const legacy = legacyOneMinusReal(outputs);
    const neuralPAi = neuralPAiFromSourceDetector(outputs);
    const fused = fuseScores(neuralPAi, await analyzeHeuristics(buffer, path), DEFAULT_THRESHOLD);
    const predictedAi = isAiAtThreshold(fused.rawScore, DEFAULT_THRESHOLD);

    rows.push({
      file: path,
      label,
      raw_score: fused.rawScore,
      neural_score: fused.neuralScore,
      verdict: fused.verdict,
      predicted_ai: predictedAi,
      reasons: fused.reasons.join('; '),
      legacy,
    });

    legacyRows.push({
      label,
      pred: legacy >= DEFAULT_THRESHOLD,
    });

    if (compareLegacy) {
      console.log(
        `${path},${label || ''},${legacy.toFixed(4)},${neuralPAi.toFixed(4)},${legacy >= DEFAULT_THRESHOLD},${predictedAi}`
      );
    } else {
      console.log(
        `${path},${label || ''},${fused.rawScore.toFixed(4)},${fused.neuralScore.toFixed(4)},${fused.verdict},${predictedAi},"${fused.reasons.join('; ')}"`
      );
    }
  }

  const metrics = balancedAccuracy(rows);
  const legacyMetrics = balancedAccuracy(legacyRows.map((r, i) => ({
    label: rows[i].label,
    pred: r.pred,
  })));

  console.log('');
  console.log(`Scored ${files.length} image(s). Threshold: raw p(AI) >= ${DEFAULT_THRESHOLD} (no remapping).`);
  console.log('Neural: top AI head from source-detector (not 1 - p(real)).');

  if (metrics) {
    console.log(`Balanced accuracy @ ${DEFAULT_THRESHOLD}: ${(metrics.balanced * 100).toFixed(2)}%`);
    console.log(
      `AI recall: ${(metrics.tpr * 100).toFixed(1)}%, real recall: ${(metrics.tnr * 100).toFixed(1)}%`
    );
  }

  if (compareLegacy && legacyMetrics) {
    console.log(`Legacy 1-p(real) balanced accuracy: ${(legacyMetrics.balanced * 100).toFixed(2)}%`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
