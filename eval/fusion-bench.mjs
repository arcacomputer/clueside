#!/usr/bin/env node
/**
 * Score CF adaptive TTA + DINO probe with production fuseNeuralScores.
 * Usage: node eval/fusion-bench.mjs <labeled-dir>
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web';
import { RawImage } from '@huggingface/transformers';
import { fuseNeuralScores, DEFAULT_THRESHOLD, isAiAtThreshold } from '../src/fuse.js';
import { preprocessRawImageViews } from '../src/clip-preprocess.js';
import { foldTtaScores, TTA_ADAPTIVE_LOW } from '../src/scoring.js';
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
  dinoResizeDimensions,
  dinoPackedRgbToCHW,
  dinoScoreHiddenState,
  DINO_CROP_SIZE,
} from '../src/dino.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const AI_DIR_NAMES = new Set(['ai', 'fake', 'generated', 'synthetic']);
const REAL_DIR_NAMES = new Set(['real', 'authentic', 'photo', 'natural']);

let cfSession = null;
let dinoSession = null;
let dinoProbe = null;

async function ensureSessions() {
  if (cfSession && dinoSession) return;

  const cfPath = join(ROOT, 'models', MODEL_ID, MODEL_ONNX_PATH);
  const { session } = await createCommunityForensicsSession({
    modelUrl: cfPath,
    wasmPaths: join(ROOT, 'node_modules', 'onnxruntime-web', 'dist') + '/',
    preferWebGpu: false,
    verifyWasmAssets: false,
  });
  cfSession = session;

  const probe = JSON.parse(
    await readFile(join(ROOT, 'models/probe/dino-probe.json'), 'utf8')
  );
  dinoProbe = probe;
  const dinoPath = join(ROOT, 'models', DINO_MODEL_ID, DINO_ONNX_PATH);
  dinoSession = await ort.InferenceSession.create(dinoPath, {
    executionProviders: ['wasm'],
    logSeverityLevel: 3,
  });
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

async function dinoPreprocessRawImage(rawImage) {
  const { width: rw, height: rh } = dinoResizeDimensions(rawImage.width, rawImage.height);
  const resized = await rawImage.resize(rw, rh);
  const sx = Math.floor((rw - DINO_CROP_SIZE) / 2);
  const sy = Math.floor((rh - DINO_CROP_SIZE) / 2);
  const cropped = await resized.crop([sx, sy, sx + DINO_CROP_SIZE - 1, sy + DINO_CROP_SIZE - 1]);
  const rgba = cropped.data;
  const channels = cropped.channels || 4;
  return dinoPackedRgbToCHW(rgba, channels);
}

async function scoreFile(filePath, label) {
  const rawImage = await RawImage.read(filePath);
  const views = await preprocessRawImageViews(rawImage);
  const dinoChw = await dinoPreprocessRawImage(rawImage);
  const dinoInput = new ort.Tensor('float32', dinoChw, [1, 3, DINO_CROP_SIZE, DINO_CROP_SIZE]);
  const dinoOut = await dinoSession.run({ [DINO_INPUT_NAME]: dinoInput });
  const dinoPAi = dinoScoreHiddenState(dinoOut.last_hidden_state, dinoProbe);

  const dinoSuspicious = dinoPAi >= TTA_ADAPTIVE_LOW;
  const mode = dinoSuspicious ? 'always' : 'adaptive';
  const viewed = await predictAdaptiveViews(cfSession, views, { mode });
  const cfPAi = viewed.neuralPAi;
  const fused = fuseNeuralScores(cfPAi, dinoPAi);

  return {
    file: filePath,
    label,
    cf: cfPAi,
    dino: dinoPAi,
    fused,
    predicted_ai: isAiAtThreshold(fused, DEFAULT_THRESHOLD),
  };
}

function metrics(rows) {
  const labeled = rows.filter((r) => r.label === 'ai' || r.label === 'real');
  const aiRows = labeled.filter((r) => r.label === 'ai');
  const realRows = labeled.filter((r) => r.label === 'real');
  const tpr = aiRows.filter((r) => r.predicted_ai).length / aiRows.length;
  const tnr = realRows.filter((r) => !r.predicted_ai).length / realRows.length;
  return { ba: (tpr + tnr) / 2, tpr, tnr, ai: aiRows.length, real: realRows.length };
}

async function main() {
  const dir = resolve(process.argv[2] || '');
  if (!dir) {
    console.error('Usage: node eval/fusion-bench.mjs <labeled-dir>');
    process.exit(1);
  }

  await ensureSessions();
  const files = await walkLabeled(dir);
  const rows = [];
  for (const { path, label } of files) {
    rows.push(await scoreFile(path, label));
  }

  const m = metrics(rows);
  const oldMax = rows.map((r) => Math.max(r.cf, r.dino));
  const oldAi = oldMax.filter((s) => s >= DEFAULT_THRESHOLD).length;
  const oldRealFp = rows.filter((r) => r.label === 'real' && Math.max(r.cf, r.dino) >= DEFAULT_THRESHOLD).length;
  const aiMiss = rows.filter((r) => r.label === 'ai' && !r.predicted_ai);
  const realFp = rows.filter((r) => r.label === 'real' && r.predicted_ai);

  console.log(`Scored ${rows.length} images (CF adaptive + DINO + fuseNeuralScores)`);
  console.log(`Balanced accuracy: ${(m.ba * 100).toFixed(2)}%`);
  console.log(`AI recall (TPR): ${(m.tpr * 100).toFixed(1)}% (${m.ai} images)`);
  console.log(`Real recall (TNR): ${(m.tnr * 100).toFixed(1)}% (${m.real} images)`);
  console.log(
    `Legacy max(cf,dino) would call ${oldAi} AI; real FPs at threshold: ${oldRealFp}/${m.real}`
  );
  if (process.argv.includes('--verbose')) {
    console.log('AI misses:', aiMiss.map((r) => `${r.cf.toFixed(3)}/${r.dino.toFixed(3)} ${r.file.split('/').pop()}`).join(', '));
    console.log('Real FPs:', realFp.map((r) => `${r.cf.toFixed(3)}/${r.dino.toFixed(3)} ${r.file.split('/').pop()}`).join(', '));
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
