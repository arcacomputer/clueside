#!/usr/bin/env node
/**
 * Score labeled images with the extension's production inference and fusion policy.
 * Usage: node eval/fusion-bench.mjs <labeled-dir> [--limit=N] [--verbose] [--rows]
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, extname, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web';
import { RawImage } from '@huggingface/transformers';
import { analyzeHeuristics } from '../src/heuristics.js';
import { DEFAULT_THRESHOLD, isAiAtThreshold } from '../src/fuse.js';
import { effectiveTtaMode, fuseInferenceScores } from '../src/inference-policy.js';
import { preprocessRawImageViews } from '../src/clip-preprocess.js';
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
  dinoPreprocessRawImage,
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

async function scoreFile(filePath, label) {
  const bytes = await readFile(filePath);
  const heuristics = await analyzeHeuristics(bytes, filePath);
  const rawImage = await RawImage.read(filePath);
  const views = await preprocessRawImageViews(rawImage);
  const dinoChw = await dinoPreprocessRawImage(rawImage);
  const dinoInput = new ort.Tensor('float32', dinoChw, [1, 3, DINO_CROP_SIZE, DINO_CROP_SIZE]);
  const dinoOut = await dinoSession.run({ [DINO_INPUT_NAME]: dinoInput });
  const dinoPAi = dinoScoreHiddenState(dinoOut[DINO_OUTPUT_NAME], dinoProbe);

  const mode = effectiveTtaMode('adaptive', dinoPAi);
  const viewed = await predictAdaptiveViews(cfSession, views, { mode });
  const cfPAi = viewed.neuralPAi;
  const fused = fuseInferenceScores(cfPAi, dinoPAi, heuristics, DEFAULT_THRESHOLD);

  return {
    file: filePath,
    label,
    cf: cfPAi,
    dino: dinoPAi,
    neural: fused.neuralScore,
    fused: fused.rawScore,
    metadataForced: fused.forcedByMetadata,
    predicted_ai: isAiAtThreshold(fused.rawScore, DEFAULT_THRESHOLD),
  };
}

function metrics(rows) {
  const labeled = rows.filter((r) => r.label === 'ai' || r.label === 'real');
  const aiRows = labeled.filter((r) => r.label === 'ai');
  const realRows = labeled.filter((r) => r.label === 'real');
  if (!aiRows.length || !realRows.length) return null;
  const tpr = aiRows.filter((r) => r.predicted_ai).length / aiRows.length;
  const tnr = realRows.filter((r) => !r.predicted_ai).length / realRows.length;
  return { ba: (tpr + tnr) / 2, tpr, tnr, ai: aiRows.length, real: realRows.length };
}

async function main() {
  const args = process.argv.slice(2);
  const dirArg = args.find((arg) => !arg.startsWith('-'));
  const limitArg = args.find((arg) => arg.startsWith('--limit='));
  const limit = limitArg ? Number.parseInt(limitArg.slice('--limit='.length), 10) : null;
  if (!dirArg || (limit != null && (!Number.isInteger(limit) || limit <= 0))) {
    console.error(
      'Usage: node eval/fusion-bench.mjs <labeled-dir> [--limit=N] [--verbose] [--rows]'
    );
    process.exit(1);
  }
  const dir = resolve(dirArg);

  await ensureSessions();
  let files = await walkLabeled(dir);
  if (limit != null) {
    const ai = files.filter((file) => file.label === 'ai').slice(0, limit);
    const real = files.filter((file) => file.label === 'real').slice(0, limit);
    files = [...ai, ...real];
  }
  const rows = [];
  for (const { path, label } of files) {
    rows.push(await scoreFile(path, label));
  }

  const m = metrics(rows);
  if (!m) throw new Error('Benchmark needs both AI and real labeled images');
  const oldMax = rows.map((r) => Math.max(r.cf, r.dino));
  const oldAi = oldMax.filter((s) => s >= DEFAULT_THRESHOLD).length;
  const oldRealFp = rows.filter((r) => r.label === 'real' && Math.max(r.cf, r.dino) >= DEFAULT_THRESHOLD).length;
  const aiMiss = rows.filter((r) => r.label === 'ai' && !r.predicted_ai);
  const realFp = rows.filter((r) => r.label === 'real' && r.predicted_ai);
  const metadataForced = rows.filter((r) => r.metadataForced).length;

  console.log(`Scored ${rows.length} images (production CF + DINO + metadata fusion)`);
  console.log(`Balanced accuracy: ${(m.ba * 100).toFixed(2)}%`);
  console.log(`AI recall (TPR): ${(m.tpr * 100).toFixed(1)}% (${m.ai} images)`);
  console.log(`Real recall (TNR): ${(m.tnr * 100).toFixed(1)}% (${m.real} images)`);
  console.log(
    `Legacy max(cf,dino) would call ${oldAi} AI; real FPs at threshold: ${oldRealFp}/${m.real}`
  );
  console.log(`Metadata-forced verdicts: ${metadataForced}/${rows.length}`);
  if (process.argv.includes('--rows')) {
    console.log('label,cf,dino,fused,metadata_forced,file');
    for (const row of rows) {
      console.log(
        `${row.label},${row.cf.toFixed(6)},${row.dino.toFixed(6)},${row.fused.toFixed(6)},${row.metadataForced},${relative(dir, row.file)}`
      );
    }
  }
  if (process.argv.includes('--verbose')) {
    const describe = (row) =>
      `${row.cf.toFixed(3)}/${row.dino.toFixed(3)}/${row.fused.toFixed(3)} ${relative(dir, row.file)}`;
    console.log('AI misses:', aiMiss.map(describe).join(', '));
    console.log('Real FPs:', realFp.map(describe).join(', '));
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
