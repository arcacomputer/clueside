#!/usr/bin/env node

import { readdir, readFile, access } from 'node:fs/promises';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RawImage } from '@huggingface/transformers';
import { analyzeHeuristics } from '../src/heuristics.js';
import { fuseScores, DEFAULT_THRESHOLD, isAiAtThreshold } from '../src/fuse.js';
import { preprocessRawImageViews } from '../src/clip-preprocess.js';
import { TTA_MODES } from '../src/scoring.js';
import {
  createCommunityForensicsSession,
  predictAdaptiveViews,
  MODEL_ID,
  MODEL_ONNX_PATH,
} from '../src/community-forensics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const AI_DIR_NAMES = new Set(['ai', 'fake', 'generated', 'synthetic']);
const REAL_DIR_NAMES = new Set(['real', 'authentic', 'photo', 'natural']);

let session = null;

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  let dir = '';
  let ttaMode = 'adaptive';

  for (const arg of argv) {
    if (arg.startsWith('--tta=')) {
      ttaMode = arg.slice('--tta='.length);
    } else if (!arg.startsWith('-')) {
      dir = resolve(arg);
    }
  }

  if (!TTA_MODES.includes(ttaMode)) {
    console.error(`Unknown --tta=${ttaMode}. Use ${TTA_MODES.join('|')}.`);
    process.exit(1);
  }

  return { dir, ttaMode };
}

async function ensureSession() {
  if (session) return session;

  const modelPath = join(ROOT, 'models', MODEL_ID, MODEL_ONNX_PATH);
  if (!(await fileExists(modelPath))) {
    throw new Error(`Model weights missing at ${modelPath}. Run: npm run fetch-model`);
  }

  const { session: createdSession } = await createCommunityForensicsSession({
    modelUrl: modelPath,
    wasmPaths: join(ROOT, 'node_modules', 'onnxruntime-web', 'dist') + '/',
    preferWebGpu: false,
    verifyWasmAssets: false,
  });
  session = createdSession;

  return session;
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

async function scoreFile(activeSession, filePath, label, ttaMode) {
  const buffer = await readFile(filePath);
  const heuristics = await analyzeHeuristics(buffer, filePath);
  const rawImage = await RawImage.read(filePath);
  const views = await preprocessRawImageViews(rawImage);
  const viewed = await predictAdaptiveViews(activeSession, views, { mode: ttaMode });
  const neuralPAi = viewed.neuralPAi;
  const fused = fuseScores(neuralPAi, heuristics, DEFAULT_THRESHOLD);

  return {
    file: filePath,
    label,
    raw_score: fused.rawScore,
    neural_score: fused.neuralScore,
    verdict: fused.verdict,
    predicted_ai: isAiAtThreshold(fused.rawScore, DEFAULT_THRESHOLD),
    extra_ran: viewed.extraRan,
    early_exit: viewed.earlyExit,
    view_max: viewed.named.map((v) => `${v.name}:${v.score.toFixed(3)}`).join('|'),
    reasons: fused.reasons.join('; '),
  };
}

async function main() {
  const { dir, ttaMode } = parseArgs(process.argv.slice(2));
  if (!dir) {
    console.error('Usage: npm run eval -- <image-directory> [--tta=adaptive|always|center]');
    console.error('');
    console.error('Point at a folder with labeled subdirectories, for example:');
    console.error('  dataset/real/*.jpg');
    console.error('  dataset/ai/*.png');
    process.exit(1);
  }

  const activeSession = await ensureSession();
  const files = await walkLabeled(dir);
  if (!files.length) {
    console.error(`No images found under ${dir}`);
    process.exit(1);
  }

  console.log(
    'file,label,raw_score,neural_score,verdict,predicted_ai,extra_ran,early_exit,views,reasons'
  );

  const rows = [];
  for (const { path, label } of files) {
    const row = await scoreFile(activeSession, path, label, ttaMode);
    rows.push(row);
    console.log(
      `${row.file},${row.label || ''},${row.raw_score.toFixed(4)},${row.neural_score.toFixed(4)},${row.verdict},${row.predicted_ai},${row.extra_ran},${row.early_exit},"${row.view_max}","${row.reasons}"`
    );
  }

  const metrics = balancedAccuracy(rows);
  const labeledCount = rows.filter((r) => r.label === 'ai' || r.label === 'real').length;

  console.log('');
  console.log(`Scored ${rows.length} image(s), ${labeledCount} with folder labels.`);
  console.log(
    `Model: ${MODEL_ID} (official CLIP 384, TTA mode=${ttaMode}: max of 440 center+corners + 512 center). Threshold: raw p(AI) >= ${DEFAULT_THRESHOLD}.`
  );

  if (metrics) {
    console.log(`Balanced accuracy: ${(metrics.balanced * 100).toFixed(2)}%`);
    console.log(`AI recall (TPR): ${(metrics.tpr * 100).toFixed(1)}% (${metrics.ai} images)`);
    console.log(`Real recall (TNR): ${(metrics.tnr * 100).toFixed(1)}% (${metrics.real} images)`);
  } else {
    console.log('Balanced accuracy: n/a (need both ai/ and real/ subfolders with images).');
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
