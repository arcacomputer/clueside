#!/usr/bin/env node

/**
 * Train the logistic probe on DINOv2 features from
 * eval/extract-features.mjs. The head is deliberately tiny and
 * transparent: standardize -> w.x + b -> sigmoid. Exports probe.json
 * with the full parameterization (no lookup tables of any kind).
 *
 * Usage: node eval/train-probe.mjs <features-prefix> <probe-out.json>
 */

import { readFile, writeFile } from 'node:fs/promises';

const [prefix, outPath] = process.argv.slice(2);
if (!prefix || !outPath) {
  console.error('Usage: node eval/train-probe.mjs <features-prefix> <probe-out.json>');
  process.exit(1);
}

function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

async function loadData(prefix) {
  const metaText = await readFile(`${prefix}.jsonl`, 'utf8');
  const metas = [];
  for (const line of metaText.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec.error) metas.push(rec);
  }
  const bin = await readFile(`${prefix}.bin.part`);
  const dims = metas[0]?.dims || 768;
  const expect = metas.length * dims * 4;
  if (bin.length < expect) {
    throw new Error(`bin too small: ${bin.length} < ${expect}`);
  }
  const raw = new Float32Array(bin.buffer, bin.byteOffset, metas.length * dims);

  // Drop rows containing non-finite values (e.g. a decoder edge case):
  // a single NaN row poisons the standardization statistics for every
  // dimension and silently zeroes the model.
  const keepMetas = [];
  const keepRows = [];
  for (let i = 0; i < metas.length; i++) {
    let finite = true;
    for (let d = 0; d < dims; d++) {
      if (!Number.isFinite(raw[i * dims + d])) {
        finite = false;
        break;
      }
    }
    if (finite) {
      keepMetas.push(metas[i]);
      keepRows.push(i);
    }
  }
  if (keepMetas.length < metas.length) {
    console.error(`dropped ${metas.length - keepMetas.length} non-finite feature row(s)`);
  }
  const feats = new Float32Array(keepMetas.length * dims);
  keepRows.forEach((src, dst) => {
    feats.set(raw.subarray(src * dims, (src + 1) * dims), dst * dims);
  });
  return { metas: keepMetas, feats, dims };
}

function trainLogistic(X, y, dims, n, opts = {}) {
  const epochs = opts.epochs ?? 40;
  const lr = opts.lr ?? 2e-3;
  const l2 = opts.l2 ?? 1e-4;
  const batch = opts.batch ?? 256;

  const w = new Float64Array(dims);
  let b = 0;
  const mW = new Float64Array(dims);
  const vW = new Float64Array(dims);
  let mB = 0;
  let vB = 0;
  const beta1 = 0.9;
  const beta2 = 0.999;
  const eps = 1e-8;
  let step = 0;

  // class weights: balance ai/real
  let nPos = 0;
  for (let i = 0; i < n; i++) if (y[i] === 1) nPos++;
  const wPos = n / (2 * Math.max(1, nPos));
  const wNeg = n / (2 * Math.max(1, n - nPos));

  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  let seed = 12345;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };

  const gW = new Float64Array(dims);

  for (let epoch = 0; epoch < epochs; epoch++) {
    // shuffle
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = idx[i];
      idx[i] = idx[j];
      idx[j] = t;
    }

    for (let start = 0; start < n; start += batch) {
      const end = Math.min(n, start + batch);
      gW.fill(0);
      let gB = 0;

      for (let k = start; k < end; k++) {
        const i = idx[k];
        const off = i * dims;
        let z = b;
        for (let d = 0; d < dims; d++) z += w[d] * X[off + d];
        const p = 1 / (1 + Math.exp(-z));
        const cw = y[i] === 1 ? wPos : wNeg;
        const g = (p - y[i]) * cw;
        for (let d = 0; d < dims; d++) gW[d] += g * X[off + d];
        gB += g;
      }

      const m = end - start;
      step++;
      const bc1 = 1 - Math.pow(beta1, step);
      const bc2 = 1 - Math.pow(beta2, step);

      for (let d = 0; d < dims; d++) {
        const grad = gW[d] / m + l2 * w[d];
        mW[d] = beta1 * mW[d] + (1 - beta1) * grad;
        vW[d] = beta2 * vW[d] + (1 - beta2) * grad * grad;
        w[d] -= (lr * (mW[d] / bc1)) / (Math.sqrt(vW[d] / bc2) + eps);
      }
      const gradB = gB / m;
      mB = beta1 * mB + (1 - beta1) * gradB;
      vB = beta2 * vB + (1 - beta2) * gradB * gradB;
      b -= (lr * (mB / bc1)) / (Math.sqrt(vB / bc2) + eps);
    }
  }

  return { w, b };
}

function predict(w, b, X, dims, i) {
  const off = i * dims;
  let z = b;
  for (let d = 0; d < dims; d++) z += w[d] * X[off + d];
  return 1 / (1 + Math.exp(-z));
}

function evalSplit(w, b, X, dims, rows, threshold = 0.5) {
  let tp = 0, fn = 0, tn = 0, fp = 0;
  const scored = [];
  for (const r of rows) {
    const p = predict(w, b, X, dims, r.i);
    scored.push({ ...r, p });
    if (r.y === 1) p >= threshold ? tp++ : fn++;
    else p >= threshold ? fp++ : tn++;
  }
  const tpr = tp + fn ? tp / (tp + fn) : 0;
  const tnr = tn + fp ? tn / (tn + fp) : 0;

  // AUC via rank sum
  const pos = scored.filter((s) => s.y === 1).map((s) => s.p).sort((a, b2) => a - b2);
  const neg = scored.filter((s) => s.y === 0).map((s) => s.p).sort((a, b2) => a - b2);
  let auc = 0;
  let j = 0;
  for (const p of pos) {
    while (j < neg.length && neg[j] < p) j++;
    auc += j;
  }
  auc = pos.length && neg.length ? auc / (pos.length * neg.length) : 0;

  return { ba: (tpr + tnr) / 2, tpr, tnr, auc, scored };
}

async function main() {
  const { metas, feats, dims } = await loadData(prefix);
  const n = metas.length;
  console.log(`${n} rows, ${dims} dims`);

  // standardize
  const mean = new Float64Array(dims);
  const std = new Float64Array(dims);
  for (let i = 0; i < n; i++) {
    const off = i * dims;
    for (let d = 0; d < dims; d++) mean[d] += feats[off + d];
  }
  for (let d = 0; d < dims; d++) mean[d] /= n;
  for (let i = 0; i < n; i++) {
    const off = i * dims;
    for (let d = 0; d < dims; d++) {
      const v = feats[off + d] - mean[d];
      std[d] += v * v;
    }
  }
  for (let d = 0; d < dims; d++) std[d] = Math.sqrt(std[d] / n) || 1;

  const X = new Float32Array(n * dims);
  for (let i = 0; i < n; i++) {
    const off = i * dims;
    for (let d = 0; d < dims; d++) X[off + d] = (feats[off + d] - mean[d]) / std[d];
  }

  const y = new Uint8Array(n);
  for (let i = 0; i < n; i++) y[i] = metas[i].label === 'ai' ? 1 : 0;

  // split by filename hash: 85 train / 15 val
  const trainRows = [];
  const valRows = [];
  for (let i = 0; i < n; i++) {
    const row = { i, y: y[i], source: metas[i].source, file: metas[i].file };
    (hash01(metas[i].file) < 0.85 ? trainRows : valRows).push(row);
  }
  console.log(`train ${trainRows.length} / val ${valRows.length}`);

  // train on train split
  const Xtrain = new Float32Array(trainRows.length * dims);
  const ytrain = new Uint8Array(trainRows.length);
  trainRows.forEach((r, k) => {
    Xtrain.set(X.subarray(r.i * dims, (r.i + 1) * dims), k * dims);
    ytrain[k] = r.y;
  });
  const t0 = Date.now();
  const { w, b } = trainLogistic(Xtrain, ytrain, dims, trainRows.length);
  console.log(`trained in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const val = evalSplit(w, b, X, dims, valRows);
  console.log(`VAL: AUC ${val.auc.toFixed(4)}  BA@0.5 ${(val.ba * 100).toFixed(1)}%  TPR ${(val.tpr * 100).toFixed(1)}%  TNR ${(val.tnr * 100).toFixed(1)}%`);

  const bySource = new Map();
  for (const s of val.scored) {
    const key = `${s.y ? 'ai' : 'real'}:${s.source}`;
    if (!bySource.has(key)) bySource.set(key, { hit: 0, n: 0 });
    const e = bySource.get(key);
    e.n++;
    if ((s.y === 1) === (s.p >= 0.5)) e.hit++;
  }
  console.log(
    'per-source: ' +
      [...bySource.entries()]
        .sort()
        .map(([k, v]) => `${k} ${((100 * v.hit) / v.n).toFixed(0)}% (${v.n})`)
        .join('  ')
  );

  // refit on everything for the shipped head
  const tAll = Date.now();
  const full = trainLogistic(X, y, dims, n);
  console.log(`refit all in ${((Date.now() - tAll) / 1000).toFixed(1)}s`);

  const probe = {
    backbone: 'dinov2-small',
    pooling: 'cls+mean',
    dims,
    featureMean: [...mean].map((v) => Number(v.toFixed(6))),
    featureStd: [...std].map((v) => Number(v.toFixed(6))),
    weights: [...full.w].map((v) => Number(v.toFixed(6))),
    bias: Number(full.b.toFixed(6)),
    trainedOn: `${n} images (see eval/fetch-train.mjs sources)`,
  };
  await writeFile(outPath, JSON.stringify(probe));
  console.log(`wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
