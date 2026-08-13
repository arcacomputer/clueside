#!/usr/bin/env node

import { readdir, readFile, access } from 'node:fs/promises';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, pipeline } from '@huggingface/transformers';
import { analyzeHeuristics } from '../src/heuristics.js';
import { fuseScores, DEFAULT_THRESHOLD, isAiAtThreshold } from '../src/fuse.js';
import { neuralPAiForStrategy } from '../src/scoring.js';
import { PRIMARY_MODEL_ID, HINTS_MODEL_ID } from '../src/models.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const AI_DIR_NAMES = new Set(['ai', 'fake', 'generated', 'synthetic']);
const REAL_DIR_NAMES = new Set(['real', 'authentic', 'photo', 'natural']);
const STRATEGIES = new Set(['distilled', 'hybrid', 'legacy', 'max_ai']);

let primaryClassifier = null;
let hintsClassifier = null;

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureClassifiers() {
  if (primaryClassifier && hintsClassifier) {
    return { primaryClassifier, hintsClassifier };
  }

  const primaryOnnx = join(ROOT, 'models', PRIMARY_MODEL_ID, 'onnx', 'model_quantized.onnx');
  const hintsOnnx = join(ROOT, 'models', HINTS_MODEL_ID, 'onnx', 'model_quantized.onnx');

  if (!(await fileExists(primaryOnnx)) || !(await fileExists(hintsOnnx))) {
    throw new Error('Model weights missing. Run: npm run fetch-model');
  }

  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = join(ROOT, 'models');

  primaryClassifier = await pipeline('image-classification', PRIMARY_MODEL_ID, { dtype: 'q8' });
  hintsClassifier = await pipeline('image-classification', HINTS_MODEL_ID, { dtype: 'q8' });

  return { primaryClassifier, hintsClassifier };
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

function parseArgs(argv) {
  let dir = '';
  let strategy = 'distilled';
  let sweep = false;

  for (const arg of argv) {
    if (arg === '--sweep') sweep = true;
    else if (arg.startsWith('--strategy=')) strategy = arg.slice('--strategy='.length);
    else if (!arg.startsWith('--')) dir = arg;
  }

  if (!STRATEGIES.has(strategy)) {
    throw new Error(`Unknown strategy: ${strategy}`);
  }

  return { dir: resolve(dir), strategy, sweep };
}

async function inferFile(primary, hints, filePath) {
  const buffer = await readFile(filePath);
  const [distilledOutputs, sourceOutputs] = await Promise.all([primary(filePath), hints(filePath)]);
  const heuristics = await analyzeHeuristics(buffer, filePath);

  return { buffer, distilledOutputs, sourceOutputs, heuristics };
}

function scoreInference(filePath, label, strategy, inference) {
  const neuralPAi = neuralPAiForStrategy(
    strategy,
    inference.distilledOutputs,
    inference.sourceOutputs
  );
  const fused = fuseScores(neuralPAi, inference.heuristics, DEFAULT_THRESHOLD);

  return {
    file: filePath,
    label,
    strategy,
    raw_score: fused.rawScore,
    neural_score: fused.neuralScore,
    verdict: fused.verdict,
    predicted_ai: isAiAtThreshold(fused.rawScore, DEFAULT_THRESHOLD),
    reasons: fused.reasons.join('; '),
  };
}

async function main() {
  const { dir, strategy, sweep } = parseArgs(process.argv.slice(2));
  if (!dir) {
    console.error('Usage: npm run eval -- <image-directory> [--strategy=distilled|hybrid|legacy|max_ai] [--sweep]');
    process.exit(1);
  }

  const { primaryClassifier: primary, hintsClassifier: hints } = await ensureClassifiers();
  const files = await walkLabeled(dir);
  if (!files.length) {
    console.error(`No images found under ${dir}`);
    process.exit(1);
  }

  const strategies = sweep ? [...STRATEGIES] : [strategy];
  const inferenceByPath = new Map();

  for (const { path } of files) {
    inferenceByPath.set(path, await inferFile(primary, hints, path));
  }

  for (const current of strategies) {
    if (sweep) {
      console.log(`\n# strategy: ${current}`);
    }

    console.log('file,label,strategy,raw_score,neural_score,verdict,predicted_ai,reasons');

    const rows = [];
    for (const { path, label } of files) {
      const row = scoreInference(path, label, current, inferenceByPath.get(path));
      rows.push(row);
      console.log(
        `${row.file},${row.label || ''},${row.strategy},${row.raw_score.toFixed(4)},${row.neural_score.toFixed(4)},${row.verdict},${row.predicted_ai},"${row.reasons}"`
      );
    }

    const metrics = balancedAccuracy(rows);
    console.log('');
    console.log(`Strategy: ${current}. Threshold: raw p(AI) >= ${DEFAULT_THRESHOLD}.`);

    if (metrics) {
      console.log(`Balanced accuracy: ${(metrics.balanced * 100).toFixed(2)}%`);
      console.log(
        `AI recall (TPR): ${(metrics.tpr * 100).toFixed(1)}% (${metrics.ai} images)`
      );
      console.log(
        `Real recall (TNR): ${(metrics.tnr * 100).toFixed(1)}% (${metrics.real} images)`
      );
    } else {
      console.log('Balanced accuracy: n/a (need ai/ and real/ subfolders).');
    }
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
