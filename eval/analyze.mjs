#!/usr/bin/env node

/**
 * Offline policy simulator over eval/sweep.mjs output. Reads JSONL of
 * per-view sigmoid scores and answers: what balanced accuracy does each
 * TTA policy / aggregation / threshold get, per source, with and
 * without metadata fusion?
 *
 * Usage: node eval/analyze.mjs <sweep.jsonl> [more.jsonl...] [--threshold=0.65]
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { DINO_CF_FLOOR } from '../src/fuse.js';
import { productFloorScore } from './product-policy.mjs';
import { calibrationMetrics } from './calibration.mjs';

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
let THRESHOLD = 0.65;
const dinoFiles = [];
for (const a of args) {
  if (a.startsWith('--threshold=')) THRESHOLD = Number(a.slice('--threshold='.length));
  if (a.startsWith('--dino=')) dinoFiles.push(a.slice('--dino='.length));
}

if (!files.length) {
  console.error('Usage: node eval/analyze.mjs <sweep.jsonl> [more.jsonl...]');
  process.exit(1);
}

const VIEW_ORDER = ['center', 'tl', 'tr', 'bl', 'br', 'center_512'];

/** file -> dino probe score, loaded from --dino=<jsonl> */
const dinoByFile = new Map();

function logit(p) {
  const c = Math.max(1e-6, Math.min(1 - 1e-6, p));
  return Math.log(c / (1 - c));
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

function dinoFor(rec) {
  // Full-path match: score dino features per variant directory
  // (bench and bench-web each get their own --dino file).
  return dinoByFile.get(rec.file);
}

function viewScores(rec) {
  return VIEW_ORDER.filter((v) => rec.views[v] != null).map((v) => rec.views[v]);
}

function top2mean(scores) {
  const sorted = [...scores].sort((a, b) => b - a);
  if (sorted.length === 1) return sorted[0];
  return (sorted[0] + sorted[1]) / 2;
}

function secondMax(scores) {
  const sorted = [...scores].sort((a, b) => b - a);
  return sorted.length > 1 ? sorted[1] : sorted[0];
}

/** Policy definitions: rec -> neural score. */
const POLICIES = {
  center: (rec) => rec.views.center,
  'adaptive[0.15]': (rec) => adaptiveScore(rec, 0.15, Math.max),
  'adaptive[0.05]': (rec) => adaptiveScore(rec, 0.05, Math.max),
  'adaptive[0.02]': (rec) => adaptiveScore(rec, 0.02, Math.max),
  'adaptive[0]': (rec) => adaptiveScore(rec, 0, Math.max),
  'always-max': (rec) => Math.max(...viewScores(rec)),
  'always-top2': (rec) => top2mean(viewScores(rec)),
  'always-2ndmax': (rec) => secondMax(viewScores(rec)),
  'adaptive[0]-top2': (rec) => adaptiveScoreAgg(rec, 0, top2mean),
  'adaptive[0.02]-top2': (rec) => adaptiveScoreAgg(rec, 0.02, top2mean),
};

/** Ensemble policies appear only when --dino files are provided. */
const ENSEMBLE_POLICIES = {
  'dino-only': (rec) => dinoFor(rec) ?? 0.5,
  'ens-max': (rec) => {
    const d = dinoFor(rec);
    const cf = Math.max(...viewScores(rec));
    return d == null ? cf : Math.max(cf, d);
  },
  'ens-max-adap': (rec) => {
    const d = dinoFor(rec);
    const cf = adaptiveScore(rec, 0.02, Math.max);
    return d == null ? cf : Math.max(cf, d);
  },
  'ens-max-center': (rec) => {
    // Load-shed scenario: CF center crop only + dino. If this holds up,
    // the queue can shed CF TTA crops without losing the ensemble gain.
    const d = dinoFor(rec);
    const cf = rec.views.center;
    return d == null ? cf : Math.max(cf, d);
  },
  'ens-logitmean': (rec) => {
    const d = dinoFor(rec);
    const cf = Math.max(...viewScores(rec));
    return d == null ? cf : sigmoid((logit(cf) + logit(d)) / 2);
  },
  'ens-logitmean-w25': (rec) => {
    const d = dinoFor(rec);
    const cf = Math.max(...viewScores(rec));
    return d == null ? cf : sigmoid(0.25 * logit(cf) + 0.75 * logit(d));
  },
  'ens-noisyor': (rec) => {
    const d = dinoFor(rec);
    const cf = Math.max(...viewScores(rec));
    return d == null ? cf : 1 - (1 - cf) * (1 - d);
  },
  'ens-smart': (rec) => {
    // Production candidate: CF extra crops run only when either head is
    // at least mildly suspicious, so confident reals stay one CF pass.
    // extras iff center<t and (center>=0.15 or dino>=0.15)
    const d = dinoFor(rec) ?? 0;
    const center = rec.views.center;
    const suspicious = center >= 0.15 || d >= 0.15;
    const cf = center < THRESHOLD && suspicious ? Math.max(...viewScores(rec)) : center;
    return Math.max(cf, d);
  },
  'ens-cf-gated': (rec) => {
    const d = dinoFor(rec);
    const cf = adaptiveScore(rec, 0.02, Math.max);
    if (d == null) return cf;
    if (cf >= THRESHOLD) return cf;
    if (cf < 0.40) return cf;
    return Math.max(cf, d);
  },
  'product-current': (rec) => productFloorScore(rec, dinoFor(rec), DINO_CF_FLOOR),
  'product-floor-0.40': (rec) => productFloorScore(rec, dinoFor(rec), 0.40),
  'product-floor-0.30': (rec) => productFloorScore(rec, dinoFor(rec), 0.30),
  'product-floor-0.20': (rec) => productFloorScore(rec, dinoFor(rec), 0.20),
  'product-floor-0.15': (rec) => productFloorScore(rec, dinoFor(rec), 0.15),
  'product-floor-0.10': (rec) => productFloorScore(rec, dinoFor(rec), 0.10),
  'product-floor-0.05': (rec) => productFloorScore(rec, dinoFor(rec), 0.05),
  'product-floor-0.00': (rec) => productFloorScore(rec, dinoFor(rec), 0),
};

function adaptiveScore(rec, lo, _agg) {
  return adaptiveScoreAgg(rec, lo, (scores) => Math.max(...scores));
}

function adaptiveScoreAgg(rec, lo, agg) {
  const center = rec.views.center;
  if (center >= lo && center < THRESHOLD) {
    return agg(viewScores(rec));
  }
  return center;
}

function fused(neural, rec) {
  if (rec.heur?.c2pa || rec.heur?.meta) return 0.97;
  return neural;
}

function metrics(records, scoreFn, threshold, withFusion) {
  let tp = 0, fn = 0, tn = 0, fp = 0;
  for (const rec of records) {
    if (rec.error) {
      // Scoring failure: production shows error badge; count as not-AI prediction.
      if (rec.label === 'ai') fn++;
      else tn++;
      continue;
    }
    let score = scoreFn(rec);
    if (withFusion) score = fused(score, rec);
    const predAi = score >= threshold;
    if (rec.label === 'ai') predAi ? tp++ : fn++;
    else predAi ? fp++ : tn++;
  }
  const tpr = tp + fn ? tp / (tp + fn) : 0;
  const tnr = tn + fp ? tn / (tn + fp) : 0;
  return { ba: (tpr + tnr) / 2, tpr, tnr, n: tp + fn + tn + fp };
}

function bestThreshold(records, scoreFn, withFusion) {
  let best = { t: 0.5, ba: 0 };
  for (let t = 0.3; t <= 0.9001; t += 0.01) {
    const m = metrics(records, scoreFn, t, withFusion);
    if (m.ba > best.ba) best = { t, ba: m.ba, tpr: m.tpr, tnr: m.tnr };
  }
  return best;
}

function pct(x) {
  return (x * 100).toFixed(1).padStart(5);
}

function quantiles(sorted, qs) {
  return qs.map((q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
}

async function loadAll(paths) {
  const groups = new Map();
  for (const path of paths) {
    const records = [];
    const text = await readFile(path, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // torn line
      }
    }
    groups.set(basename(path), records);
  }
  return groups;
}

function report(name, records) {
  const ai = records.filter((r) => r.label === 'ai');
  const real = records.filter((r) => r.label === 'real');
  const errors = records.filter((r) => r.error);
  console.log(`\n=== ${name}: ${ai.length} ai / ${real.length} real (${errors.length} errors) ===`);

  const metaAi = ai.filter((r) => r.heur?.c2pa || r.heur?.meta).length;
  const metaReal = real.filter((r) => r.heur?.c2pa || r.heur?.meta).length;
  console.log(`metadata-forced: ${metaAi} ai, ${metaReal} real (real ones are false forces!)`);

  const activePolicies = dinoByFile.size
    ? { ...POLICIES, ...ENSEMBLE_POLICIES }
    : POLICIES;

  console.log(`\npolicy                 @${THRESHOLD}  BA    TPR    TNR   | best-t  BA`);
  for (const [pname, fn] of Object.entries(activePolicies)) {
    const at = metrics(records, fn, THRESHOLD, true);
    const best = bestThreshold(records, fn, true);
    console.log(
      `${pname.padEnd(22)} ${pct(at.ba)} ${pct(at.tpr)} ${pct(at.tnr)}  | t=${best.t.toFixed(2)} ${pct(best.ba)}`
    );
  }

  const centerNoFuse = metrics(records, POLICIES.center, THRESHOLD, false);
  console.log(`center w/o fusion      ${pct(centerNoFuse.ba)} ${pct(centerNoFuse.tpr)} ${pct(centerNoFuse.tnr)}`);

  if (dinoByFile.size) {
    const calibration = calibrationMetrics(
      records,
      (rec) => fused(ENSEMBLE_POLICIES['product-current'](rec), rec)
    );
    if (calibration.n) {
      console.log(
        `product-current raw calibration: Brier ${calibration.brier.toFixed(4)}, ECE-10 ${calibration.ece.toFixed(4)} (n=${calibration.n})`
      );
    }
  }

  // Per-source recall at the operating threshold for a few key policies.
  const perSourceList = dinoByFile.size
    ? [
        'center',
        'always-max',
        'dino-only',
        'ens-max',
        'ens-smart',
        'product-current',
        'product-floor-0.40',
      ]
    : ['center', 'adaptive[0.15]', 'adaptive[0]', 'always-max', 'always-top2'];
  for (const pname of perSourceList) {
    const fn = activePolicies[pname];
    const yields = new Map();
    for (const rec of records) {
      if (rec.error) continue;
      const key = `${rec.label}:${rec.source}`;
      if (!yields.has(key)) yields.set(key, { hit: 0, n: 0 });
      const y = yields.get(key);
      y.n++;
      const score = fused(fn(rec), rec);
      const predAi = score >= THRESHOLD;
      if ((rec.label === 'ai') === predAi) y.hit++;
    }
    const parts = [...yields.entries()]
      .sort()
      .map(([k, v]) => `${k} ${((100 * v.hit) / v.n).toFixed(0)}% (${v.n})`)
      .join('  ');
    console.log(`\n[${pname}] per-source correct: ${parts}`);
  }

  // Score distributions (center + always-max) to see calibration headroom.
  for (const pname of ['center', 'always-max']) {
    const fn = POLICIES[pname];
    const aiScores = ai.filter((r) => !r.error).map(fn).sort((a, b) => a - b);
    const realScores = real.filter((r) => !r.error).map(fn).sort((a, b) => a - b);
    const qs = [0.1, 0.25, 0.5, 0.75, 0.9];
    if (aiScores.length && realScores.length) {
      console.log(`\n[${pname}] ai quantiles   ${quantiles(aiScores, qs).map((v) => v.toFixed(3)).join(' ')}`);
      console.log(`[${pname}] real quantiles ${quantiles(realScores, qs).map((v) => v.toFixed(3)).join(' ')}`);
    }
  }
}

for (const dinoPath of dinoFiles) {
  const text = await readFile(dinoPath, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      dinoByFile.set(rec.file, rec.dino);
    } catch {
      // torn line
    }
  }
}

const groups = await loadAll(files);
for (const [name, records] of groups) {
  report(name, records);
}

if (groups.size > 1) {
  const all = [...groups.values()].flat();
  report('COMBINED', all);
}
