#!/usr/bin/env node

import { readdir, readFile, access } from 'node:fs/promises';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web';
import { RawImage } from '@huggingface/transformers';
import { analyzeHeuristics } from '../src/heuristics.js';
import { analyzeGraphicPackedPixels } from '../src/graphic-gate.js';
import { DEFAULT_THRESHOLD, isAiAtThreshold } from '../src/fuse.js';
import { effectiveTtaMode, fuseInferenceScores } from '../src/inference-policy.js';
import { preprocessRawImageViews } from '../src/clip-preprocess.js';
import { TTA_MODES } from '../src/scoring.js';
import {
  createCommunityForensicsSession,
  predictAdaptiveViews,
  MODEL_ID,
  MODEL_ONNX_PATH,
} from '../src/community-forensics.js';
import {
  DINO_MODEL_ID,
  DINO_ONNX_PATH,
  DINO_INPUT_NAME,
  DINO_OUTPUT_NAME,
  DINO_CROP_SIZE,
  dinoPreprocessRawImage,
  dinoScoreHiddenState,
} from '../src/dino.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const AI_DIR_NAMES = new Set(['ai', 'fake', 'generated', 'synthetic']);
const REAL_DIR_NAMES = new Set(['real', 'authentic', 'photo', 'natural']);

let cfSession = null;
let dinoSession = null;
let dinoProbe = null;

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

async function ensureSessions() {
  if (cfSession && dinoSession && dinoProbe) {
    return { cfSession, dinoSession, dinoProbe };
  }

  const cfPath = join(ROOT, 'models', MODEL_ID, MODEL_ONNX_PATH);
  const dinoPath = join(ROOT, 'models', DINO_MODEL_ID, DINO_ONNX_PATH);
  const probePath = join(ROOT, 'models', 'probe', 'dino-probe.json');
  const required = [cfPath, dinoPath, probePath];
  for (const path of required) {
    if (!(await fileExists(path))) {
      throw new Error(`Required model asset missing at ${path}. Run: npm run fetch-model`);
    }
  }

  const { session: createdCfSession } = await createCommunityForensicsSession({
    modelUrl: cfPath,
    wasmPaths: join(ROOT, 'node_modules', 'onnxruntime-web', 'dist') + '/',
    preferWebGpu: false,
    verifyWasmAssets: false,
  });
  cfSession = createdCfSession;
  dinoProbe = JSON.parse(await readFile(probePath, 'utf8'));
  dinoSession = await ort.InferenceSession.create(dinoPath, {
    executionProviders: ['wasm'],
    logSeverityLevel: 3,
  });

  return { cfSession, dinoSession, dinoProbe };
}

async function walkLabeled(dir, parentLabel = null) {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
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

function csv(value) {
  if (value == null) return '';
  const string = String(value);
  return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

async function scoreFile(sessions, filePath, label, ttaMode) {
  const buffer = await readFile(filePath);
  const heuristics = await analyzeHeuristics(buffer, filePath);
  const rawImage = await RawImage.read(filePath);
  const graphicGate = analyzeGraphicPackedPixels(
    rawImage.data,
    rawImage.width,
    rawImage.height,
    rawImage.channels
  ).isGraphic;

  const dinoChw = await dinoPreprocessRawImage(rawImage);
  const dinoInput = new ort.Tensor(
    'float32',
    dinoChw,
    [1, 3, DINO_CROP_SIZE, DINO_CROP_SIZE]
  );
  const dinoOutputs = await sessions.dinoSession.run({ [DINO_INPUT_NAME]: dinoInput });
  const dinoPAi = dinoScoreHiddenState(dinoOutputs[DINO_OUTPUT_NAME], sessions.dinoProbe);

  const views = await preprocessRawImageViews(rawImage);
  const effectiveMode = effectiveTtaMode(ttaMode, dinoPAi);
  const viewed = await predictAdaptiveViews(sessions.cfSession, views, { mode: effectiveMode });
  const cfPAi = viewed.neuralPAi;
  const fused = fuseInferenceScores(cfPAi, dinoPAi, heuristics, DEFAULT_THRESHOLD, {
    graphicGate,
  });

  return {
    file: filePath,
    label,
    raw_score: fused.rawScore,
    neural_score: fused.neuralScore,
    cf_score: cfPAi,
    dino_score: dinoPAi,
    verdict: fused.verdict,
    predicted_ai: isAiAtThreshold(fused.rawScore, DEFAULT_THRESHOLD),
    forced_by_metadata: fused.forcedByMetadata,
    graphic_gate: graphicGate,
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

  const sessions = await ensureSessions();
  const files = await walkLabeled(dir);
  if (!files.length) {
    console.error(`No images found under ${dir}`);
    process.exit(1);
  }

  console.log(
    'file,label,raw_score,neural_score,cf_score,dino_score,verdict,predicted_ai,forced_by_metadata,graphic_gate,extra_ran,early_exit,views,reasons'
  );

  const rows = [];
  for (const { path, label } of files) {
    const row = await scoreFile(sessions, path, label, ttaMode);
    rows.push(row);
    console.log([
      csv(row.file),
      csv(row.label),
      row.raw_score.toFixed(4),
      row.neural_score.toFixed(4),
      row.cf_score.toFixed(4),
      row.dino_score.toFixed(4),
      row.verdict,
      row.predicted_ai,
      row.forced_by_metadata,
      row.graphic_gate,
      row.extra_ran,
      row.early_exit,
      csv(row.view_max),
      csv(row.reasons),
    ].join(','));
  }

  const metrics = balancedAccuracy(rows);
  const labeledCount = rows.filter((r) => r.label === 'ai' || r.label === 'real').length;

  console.log('');
  console.log(`Scored ${rows.length} image(s), ${labeledCount} with folder labels.`);
  console.log(
    `Models: ${MODEL_ID} + ${DINO_MODEL_ID} probe (production CF-primary fusion, TTA mode=${ttaMode}). Threshold: raw p(AI) >= ${DEFAULT_THRESHOLD}.`
  );

  if (metrics) {
    console.log(`Balanced accuracy: ${(metrics.balanced * 100).toFixed(2)}%`);
    console.log(`AI recall (TPR): ${(metrics.tpr * 100).toFixed(1)}% (${metrics.ai} images)`);
    console.log(`Real recall (TNR): ${(metrics.tnr * 100).toFixed(1)}% (${metrics.real} images)`);
  } else {
    console.log('Balanced accuracy: n/a (need both ai/ and real/ subfolders with images).');
  }

  await sessions.cfSession.release();
  await sessions.dinoSession.release();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
