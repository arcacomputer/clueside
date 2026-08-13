#!/usr/bin/env node

/**
 * Build a local labeled benchmark from public HF datasets via the
 * datasets-server rows API. Images land in <out>/{ai,real}/ with a
 * source prefix per file so per-generator recall can be reported.
 *
 * Usage: node eval/fetch-bench.mjs <out-dir>
 *
 * Dataset images are used locally for evaluation only and are not
 * committed or redistributed.
 */

import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = process.argv[2];
if (!OUT) {
  console.error('Usage: node eval/fetch-bench.mjs <out-dir>');
  process.exit(1);
}

const API = 'https://datasets-server.huggingface.co';

/**
 * @typedef {object} SourceSpec
 * @property {string} name short prefix for files
 * @property {'ai'|'real'} label
 * @property {string} dataset
 * @property {string} [config]
 * @property {string} [split]
 * @property {string[]} columns image column names to pull
 * @property {number} count total images wanted
 * @property {number[]} offsets rows offsets to page through (100 rows each)
 */

/** @type {SourceSpec[]} */
const SOURCES = [
  // --- AI ---
  { name: 'mjhq', label: 'ai', dataset: 'playgroundai/MJHQ-30K', columns: ['image'], count: 90, offsets: [0, 4000, 12000] },
  { name: 'dalle3', label: 'ai', dataset: 'ehristoforu/dalle-3-images', columns: ['image'], count: 90, offsets: [0, 300, 600] },
  { name: 'gpt4o', label: 'ai', dataset: 'Yejy53/GPT-ImgEval', columns: ['image'], count: 60, offsets: [0, 200] },
  { name: 'flux11', label: 'ai', dataset: 'Rapidata/flux1.1-likert-scale-preference', columns: ['image'], count: 90, offsets: [0, 300, 600] },
  { name: 'sdelsa', label: 'ai', dataset: 'elsaEU/ELSA_D3', split: 'validation', columns: ['image_gen0', 'image_gen2'], count: 80, offsets: [0, 200] },
  // --- Real ---
  { name: 'coco', label: 'real', dataset: 'rafaelpadilla/coco2017', split: 'val', columns: ['image'], count: 140, offsets: [0, 1000] },
  { name: 'flickr', label: 'real', dataset: 'nlphuji/flickr30k', columns: ['image'], count: 130, offsets: [0, 500] },
  { name: 'imgnet', label: 'real', dataset: 'frgfm/imagenette', columns: ['image'], count: 100, offsets: [0, 3000] },
  { name: 'celeba', label: 'real', dataset: 'nielsr/CelebA-faces', columns: ['image'], count: 60, offsets: [0] },
  { name: 'food', label: 'real', dataset: 'ethz/food101', columns: ['image'], count: 60, offsets: [0] },
];

const FETCH_TIMEOUT = 30000;
const CONCURRENCY = 8;

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function resolveConfigSplit(spec) {
  const data = await fetchJson(`${API}/splits?dataset=${encodeURIComponent(spec.dataset)}`);
  const splits = data.splits || [];
  if (!splits.length) throw new Error(`No splits for ${spec.dataset}`);
  const match =
    splits.find((s) => (!spec.config || s.config === spec.config) && (!spec.split || s.split === spec.split)) ||
    splits[0];
  return { config: match.config, split: match.split };
}

function extToUse(url, contentType) {
  if (/\.png(\?|$)/i.test(url) || contentType?.includes('png')) return 'png';
  if (/\.webp(\?|$)/i.test(url) || contentType?.includes('webp')) return 'webp';
  return 'jpg';
}

async function downloadImage(url, destBase) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const type = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 4096) throw new Error('too small');
  const path = `${destBase}.${extToUse(url, type)}`;
  await writeFile(path, buf);
  return path;
}

async function pool(items, worker, concurrency) {
  const queue = [...items];
  let done = 0;
  let failed = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        await worker(item);
        done++;
      } catch {
        failed++;
      }
    }
  });
  await Promise.all(runners);
  return { done, failed };
}

async function pullSource(spec) {
  const dir = join(OUT, spec.label);
  await mkdir(dir, { recursive: true });

  let resolved;
  try {
    resolved = await resolveConfigSplit(spec);
  } catch (err) {
    console.error(`[${spec.name}] SKIP: ${err.message}`);
    return;
  }

  const jobs = [];
  let seq = 0;

  for (const offset of spec.offsets) {
    if (jobs.length >= spec.count) break;
    let rowsData;
    try {
      rowsData = await fetchJson(
        `${API}/rows?dataset=${encodeURIComponent(spec.dataset)}&config=${encodeURIComponent(resolved.config)}&split=${encodeURIComponent(resolved.split)}&offset=${offset}&length=100`
      );
    } catch (err) {
      console.error(`[${spec.name}] rows offset=${offset} failed: ${err.message}`);
      continue;
    }

    for (const row of rowsData.rows || []) {
      if (jobs.length >= spec.count) break;
      for (const col of spec.columns) {
        if (jobs.length >= spec.count) break;
        const cell = row.row?.[col];
        const src = cell?.src;
        if (!src) continue;
        const idx = seq++;
        jobs.push({ src, destBase: join(dir, `${spec.name}-${String(idx).padStart(4, '0')}`) });
      }
    }
  }

  const { done, failed } = await pool(jobs, (j) => downloadImage(j.src, j.destBase), CONCURRENCY);
  console.log(`[${spec.name}] ${done} downloaded, ${failed} failed (${spec.label})`);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  for (const spec of SOURCES) {
    await pullSource(spec);
  }
  for (const label of ['ai', 'real']) {
    try {
      const files = await readdir(join(OUT, label));
      console.log(`${label}: ${files.length} files`);
    } catch {
      console.log(`${label}: 0 files`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
