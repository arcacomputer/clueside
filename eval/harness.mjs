#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { analyzeHeuristics } from '../src/heuristics.js';
import { fuseScores, DEFAULT_THRESHOLD } from '../src/fuse.js';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) files.push(...(await walk(full)));
    else if (IMAGE_EXT.has(extname(ent.name).toLowerCase())) files.push(full);
  }
  return files;
}

async function scoreFile(path) {
  const buffer = await readFile(path);
  const heuristics = await analyzeHeuristics(buffer, path);
  const neuralPAi = 0.5;
  const fused = fuseScores(neuralPAi, heuristics, DEFAULT_THRESHOLD);
  return {
    file: path,
    raw_score: fused.rawScore.toFixed(4),
    neural_score: fused.neuralScore.toFixed(4),
    verdict: fused.verdict,
    reasons: fused.reasons.join('; '),
  };
}

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: npm run eval -- <image-directory>');
    process.exit(1);
  }

  const files = await walk(dir);
  console.log('file,raw_score,neural_score,verdict,reasons');
  for (const file of files) {
    const row = await scoreFile(file);
    console.log(`${row.file},${row.raw_score},${row.neural_score},${row.verdict},"${row.reasons}"`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
