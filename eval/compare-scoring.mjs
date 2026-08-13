#!/usr/bin/env node
/**
 * Compare legacy 1-p(real) scoring vs new ensemble on a labeled folder.
 */

import { readdir, readFile, access } from 'node:fs/promises';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, pipeline } from '@huggingface/transformers';
import { parseSourceDetectorOutputs } from '../src/scoring.js';
import { ensembleNeuralPAi } from '../src/scoring.js';
import { DEFAULT_THRESHOLD } from '../src/fuse.js';
import { SOURCE_MODEL_ID, BINARY_MODEL_ID } from '../src/models.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

async function walk(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(full)));
    else if (IMAGE_EXT.has(extname(ent.name).toLowerCase())) out.push(full);
  }
  return out;
}

function legacyScore(outputs) {
  const parsed = parseSourceDetectorOutputs(outputs);
  return parsed.oneMinusReal;
}

function ba(rows) {
  const ai = rows.filter((r) => r.label === 'ai');
  const real = rows.filter((r) => r.label === 'real');
  if (!ai.length || !real.length) return null;
  const tpr = ai.filter((r) => r.pred).length / ai.length;
  const tnr = real.filter((r) => !r.pred).length / real.length;
  return { balanced: (tpr + tnr) / 2, tpr, tnr };
}

async function main() {
  const dir = resolve(process.argv[2] || '');
  if (!dir) {
    console.error('Usage: node eval/compare-scoring.mjs <labeled-folder>');
    process.exit(1);
  }

  env.localModelPath = join(ROOT, 'models');
  env.allowLocalModels = true;
  env.allowRemoteModels = false;

  const source = await pipeline('image-classification', SOURCE_MODEL_ID, { dtype: 'q8' });
  const binary = await pipeline('image-classification', BINARY_MODEL_ID, { dtype: 'q8' });

  const files = await walk(dir);
  const legacyRows = [];
  const newRows = [];

  console.log('file,label,legacy,new,legacy_pred,new_pred');

  for (const file of files) {
    const parts = file.split('/');
    const label = parts.includes('ai') ? 'ai' : parts.includes('real') ? 'real' : '';
    const [sourceOut, binaryOut] = await Promise.all([source(file), binary(file)]);
    const legacy = legacyScore(sourceOut);
    const neu = ensembleNeuralPAi(sourceOut, binaryOut);
    const legacyPred = legacy >= DEFAULT_THRESHOLD;
    const newPred = neu >= DEFAULT_THRESHOLD;
    legacyRows.push({ label, pred: legacyPred });
    newRows.push({ label, pred: newPred });
    console.log(
      `${file},${label},${legacy.toFixed(4)},${neu.toFixed(4)},${legacyPred},${newPred}`
    );
  }

  const legacyBa = ba(legacyRows);
  const newBa = ba(newRows);
  console.log('');
  if (legacyBa) {
    console.log(`Legacy 1-p(real) BA: ${(legacyBa.balanced * 100).toFixed(2)}%`);
    console.log(`New ensemble BA: ${(newBa.balanced * 100).toFixed(2)}%`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
