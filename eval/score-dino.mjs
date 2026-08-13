#!/usr/bin/env node

/**
 * Score extracted DINOv2 features with a trained probe.
 *
 * Usage: node eval/score-dino.mjs <features-prefix> <probe.json> <out.jsonl>
 */

import { readFile, writeFile } from 'node:fs/promises';

const [prefix, probePath, outPath] = process.argv.slice(2);
if (!prefix || !probePath || !outPath) {
  console.error('Usage: node eval/score-dino.mjs <features-prefix> <probe.json> <out.jsonl>');
  process.exit(1);
}

const probe = JSON.parse(await readFile(probePath, 'utf8'));
const { dims } = probe;
const mean = probe.featureMean;
const std = probe.featureStd;
const w = probe.weights;
const b = probe.bias;

const metaText = await readFile(`${prefix}.jsonl`, 'utf8');
const metas = [];
for (const line of metaText.split('\n')) {
  if (!line.trim()) continue;
  try {
    const rec = JSON.parse(line);
    if (!rec.error) metas.push(rec);
  } catch {
    // torn line
  }
}

const bin = await readFile(`${prefix}.bin.part`);
const feats = new Float32Array(bin.buffer, bin.byteOffset, metas.length * dims);

const lines = [];
for (let i = 0; i < metas.length; i++) {
  const off = i * dims;
  let z = b;
  for (let d = 0; d < dims; d++) {
    z += w[d] * ((feats[off + d] - mean[d]) / std[d]);
  }
  const p = 1 / (1 + Math.exp(-z));
  lines.push(JSON.stringify({ file: metas[i].file, label: metas[i].label, source: metas[i].source, dino: p }));
}

await writeFile(outPath, lines.join('\n') + '\n');
console.log(`${lines.length} scores -> ${outPath}`);
