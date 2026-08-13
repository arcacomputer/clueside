#!/usr/bin/env node

/**
 * Build the probe TRAINING set. Sources are chosen to be disjoint from
 * eval/fetch-bench.mjs: different datasets where possible, and offset
 * ranges >= 200 where the same dataset must be reused (fetch-bench fills
 * its counts from the first rows of offset 0, so rows 200+ never appear
 * in the eval bench).
 *
 * Usage: node eval/fetch-train.mjs <out-dir>
 */

import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = process.argv[2];
if (!OUT) {
  console.error('Usage: node eval/fetch-train.mjs <out-dir>');
  process.exit(1);
}

const API = 'https://datasets-server.huggingface.co';

/** @type {Array<{name:string,label:'ai'|'real',dataset:string,config?:string,split?:string,columns:string[],count:number,offsets:number[]}>} */
const SOURCES = [
  // --- AI ---
  { name: 'oipflux', label: 'ai', dataset: 'data-is-better-together/open-image-preferences-v1-binarized', columns: ['chosen', 'rejected'], count: 2800, offsets: [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300] },
  { name: 'mjhq', label: 'ai', dataset: 'playgroundai/MJHQ-30K', columns: ['image'], count: 700, offsets: [200, 300, 400, 500, 600, 700, 800] },
  { name: 'dalle3', label: 'ai', dataset: 'ehristoforu/dalle-3-images', columns: ['image'], count: 400, offsets: [200, 300, 400, 500] },
  { name: 'gpt4o', label: 'ai', dataset: 'Yejy53/GPT-ImgEval', columns: ['image'], count: 300, offsets: [300, 400, 500, 600] },
  { name: 'flux11', label: 'ai', dataset: 'Rapidata/flux1.1-likert-scale-preference', columns: ['image'], count: 500, offsets: [200, 300, 400, 500, 700, 900, 1000] },
  { name: 'sdelsa', label: 'ai', dataset: 'elsaEU/ELSA_D3', split: 'validation', columns: ['image_gen0', 'image_gen2'], count: 400, offsets: [200, 300, 400, 500] },
  // --- Real ---
  { name: 'sun397', label: 'real', dataset: 'tanganke/sun397', columns: ['image'], count: 2000, offsets: [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 6000, 7000, 8000, 9000, 10000, 12000, 15000, 20000, 25000] },
  { name: 'cocotr', label: 'real', dataset: 'rafaelpadilla/coco2017', split: 'train', columns: ['image'], count: 1500, offsets: [0, 500, 1000, 2000, 3000, 4000, 5000, 6000, 8000, 10000, 12000, 15000, 20000, 30000, 40000] },
  { name: 'flickr', label: 'real', dataset: 'nlphuji/flickr30k', columns: ['image'], count: 400, offsets: [600, 800, 1000, 1200] },
  { name: 'food', label: 'real', dataset: 'ethz/food101', columns: ['image'], count: 300, offsets: [200, 400, 600] },
  { name: 'celeba', label: 'real', dataset: 'nielsr/CelebA-faces', columns: ['image'], count: 300, offsets: [200, 400, 600] },
  { name: 'imgnet', label: 'real', dataset: 'frgfm/imagenette', columns: ['image'], count: 300, offsets: [5000, 6000, 7000] },
];

const FETCH_TIMEOUT = 30000;
const CONCURRENCY = 10;

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
  await writeFile(`${destBase}.${extToUse(url, type)}`, buf);
}

async function pool(items, worker, concurrency) {
  const queue = [...items];
  let done = 0;
  let failed = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const item = queue.shift();
        try {
          await worker(item);
          done++;
        } catch {
          failed++;
        }
      }
    })
  );
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

  const perOffset = Math.ceil(spec.count / spec.offsets.length);
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

    let fromThisOffset = 0;
    for (const row of rowsData.rows || []) {
      if (jobs.length >= spec.count || fromThisOffset >= perOffset) break;
      for (const col of spec.columns) {
        if (jobs.length >= spec.count || fromThisOffset >= perOffset) break;
        const src = row.row?.[col]?.src;
        if (!src) continue;
        jobs.push({ src, destBase: join(dir, `${spec.name}-${String(seq++).padStart(5, '0')}`) });
        fromThisOffset++;
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
      console.log(`${label}: ${(await readdir(join(OUT, label))).length} files`);
    } catch {
      console.log(`${label}: 0 files`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
