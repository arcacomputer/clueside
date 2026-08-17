#!/usr/bin/env node

/**
 * Offline comparison of the v1.3.2 live-page path against the shipped
 * policy, over a sweep JSONL (every TTA view, no early exit).
 *
 * Policies:
 *   load-shed     CF center only (what a >12-image page used to do)
 *   v1.3.2        adaptive extras, early-exit 0.85, then agreement
 *   production    adaptive extras, early-exit 0.95, then agreement
 *
 * Does not remap scores. Decision stays raw fused p(AI) >= 0.65.
 *
 * Usage:
 *   node eval/compare-tta-policy.mjs <sweep.jsonl> [--dino=scores.jsonl]
 */

import { readFile } from 'node:fs/promises';
import { DEFAULT_THRESHOLD, fuseNeuralScores } from '../src/fuse.js';
import { foldTtaScores } from '../src/scoring.js';
import { effectiveTtaMode } from '../src/inference-policy.js';
import { PRODUCT_VIEW_ORDER, heuristicSignalsForSweep } from './product-policy.mjs';
import { fuseInferenceScores } from '../src/inference-policy.js';

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
const dinoFiles = args.filter((a) => a.startsWith('--dino=')).map((a) => a.slice('--dino='.length));

if (!files.length) {
  console.error('Usage: node eval/compare-tta-policy.mjs <sweep.jsonl> [--dino=scores.jsonl]');
  process.exit(1);
}

const dinoByFile = new Map();
for (const path of dinoFiles) {
  const text = await readFile(path, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      dinoByFile.set(rec.file, rec.dino);
    } catch {
      // torn
    }
  }
}

function viewList(rec) {
  return PRODUCT_VIEW_ORDER.map((name) => rec.views?.[name]).filter((score) => score != null);
}

function scorePolicy(rec, earlyExit, centerOnly) {
  const dino = dinoByFile.has(rec.file) ? dinoByFile.get(rec.file) : null;
  const scores = viewList(rec);
  if (!scores.length) return { raw: 0.5, cf: 0.5, extraRan: false, earlyExit: false };
  const mode = centerOnly ? 'center' : effectiveTtaMode('adaptive', dino);
  const folded = foldTtaScores(scores, { mode, earlyExit });
  const fused = fuseInferenceScores(
    folded.neuralPAi,
    dino,
    heuristicSignalsForSweep(rec),
    DEFAULT_THRESHOLD,
    { graphicGate: rec.graphicGate === true }
  );
  return {
    raw: fused.rawScore,
    cf: folded.neuralPAi,
    extraRan: folded.extraRan,
    earlyExit: folded.earlyExit,
    neural: fuseNeuralScores(folded.neuralPAi, dino, { graphicGate: rec.graphicGate === true }),
  };
}

const POLICIES = {
  'load-shed': (rec) => scorePolicy(rec, 0.85, true),
  'v1.3.2': (rec) => scorePolicy(rec, 0.85, false),
  production: (rec) => scorePolicy(rec, 0.95, false),
};

function metrics(records, fn) {
  let tp = 0;
  let fnn = 0;
  let tn = 0;
  let fp = 0;
  const fps = [];
  const fns = [];
  for (const rec of records) {
    if (rec.error || rec.label !== 'ai' && rec.label !== 'real') continue;
    const scored = fn(rec);
    const predAi = scored.raw >= DEFAULT_THRESHOLD;
    if (rec.label === 'ai') {
      if (predAi) tp++;
      else {
        fnn++;
        fns.push({ file: rec.file, ...scored });
      }
    } else if (predAi) {
      fp++;
      fps.push({ file: rec.file, source: rec.source, ...scored, views: rec.views });
    } else {
      tn++;
    }
  }
  const tpr = tp + fnn ? tp / (tp + fnn) : 0;
  const tnr = tn + fp ? tn / (tn + fp) : 0;
  return { tp, fn: fnn, tn, fp, tpr, tnr, ba: (tpr + tnr) / 2, n: tp + fnn + tn + fp, fps, fns };
}

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

const records = [];
for (const path of files) {
  const text = await readFile(path, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // torn
    }
  }
}

const ai = records.filter((r) => r.label === 'ai' && !r.error);
const real = records.filter((r) => r.label === 'real' && !r.error);
const live = real.filter((r) => String(r.source || '').startsWith('live') || /livecdn/i.test(r.file || ''));
const product = real.filter((r) => String(r.source || '').startsWith('product') || /product-/i.test(r.file || ''));

console.log(`Records: ${records.length} (${ai.length} ai, ${real.length} real, ${records.filter((r) => r.error).length} errors)`);
console.log(`Threshold: raw fused p(AI) >= ${DEFAULT_THRESHOLD} (no remapping)`);
console.log('');
console.log('policy          n     BA     TPR    TNR    FP   FN');
for (const [name, fn] of Object.entries(POLICIES)) {
  const m = metrics(records, fn);
  console.log(
    `${name.padEnd(14)} ${String(m.n).padStart(4)}  ${pct(m.ba).padStart(6)} ${pct(m.tpr).padStart(6)} ${pct(m.tnr).padStart(6)}  ${String(m.fp).padStart(3)}  ${String(m.fn).padStart(3)}`
  );
}

function subsetReport(title, subset) {
  if (!subset.length) return;
  console.log(`\n${title} (n=${subset.length} reals)`);
  for (const [name, fn] of Object.entries(POLICIES)) {
    const m = metrics(subset, fn);
    console.log(`  ${name.padEnd(14)} FP ${m.fp}/${subset.length} (${pct(m.fp / subset.length)})`);
  }
}

subsetReport('Live-CDN Unsplash variants', live);
subsetReport('Product-CDN variants', product);

const prod = metrics(records, POLICIES.production);
if (prod.fps.length) {
  console.log('\nProduction false positives:');
  for (const row of prod.fps) {
    const views = row.views
      ? PRODUCT_VIEW_ORDER.filter((n) => row.views[n] != null)
          .map((n) => `${n}:${Number(row.views[n]).toFixed(3)}`)
          .join('|')
      : '';
    console.log(`  ${row.file} raw=${row.raw.toFixed(3)} cf=${row.cf.toFixed(3)} ${views}`);
  }
}
