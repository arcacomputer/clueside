#!/usr/bin/env node

/**
 * Build a small, runnable live-CDN / product / public-AI guard that this
 * checkout can actually score. The published 893-image bench, 240-image
 * stress set, 132-image live-CDN guard, and 100-image product guard are
 * not in git (eval/fixtures/ is ignored).
 *
 * Rows are held out from probe training and the documented stress set:
 * unsplash-lite 0-79 is the stress set, 200+ is training. This script
 * uses 80-179. Amazon Berkeley offsets 800+ are past the training 500-700
 * window. AI offsets sit past fetch-bench's first pages.
 *
 * Unsplash URLs are re-fetched as live imgix grid bytes (w=700 q=60
 * fit=crop fm=jpg). Isolation on 2026-08-16 found the processing chain,
 * not the container format, is what spikes CommunityForensics.
 *
 * Usage: node eval/fetch-live-guard.mjs <out-dir>
 *
 * Images are for local evaluation only and are not committed.
 */

import { access, mkdir, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = process.argv[2];
if (!OUT) {
  console.error('Usage: node eval/fetch-live-guard.mjs <out-dir>');
  process.exit(1);
}

const API = 'https://datasets-server.huggingface.co';
const FETCH_TIMEOUT = 30000;
const CONCURRENCY = 8;

const SOURCES = [
  {
    name: 'livecdn',
    label: 'real',
    dataset: '1aurent/unsplash-lite',
    urlColumn: 'photo.image_url',
    urlParam: 'w=700&fit=crop&q=60&fm=jpg',
    nameByRow: true,
    columns: [],
    count: 40,
    offsets: [80, 100, 120, 140],
  },
  {
    name: 'product',
    label: 'real',
    dataset: 'amaye15/amazon_berkeley_objects',
    columns: ['image'],
    minSide: 200,
    nameByRow: true,
    count: 24,
    offsets: [800, 900],
  },
  {
    name: 'flux11',
    label: 'ai',
    dataset: 'Rapidata/flux1.1-likert-scale-preference',
    columns: ['image'],
    count: 24,
    offsets: [1200],
  },
  {
    name: 'dalle3',
    label: 'ai',
    dataset: 'ehristoforu/dalle-3-images',
    columns: ['image'],
    count: 16,
    offsets: [800],
  },
];

let HF_TOKEN = process.env.HF_TOKEN || null;
if (!HF_TOKEN) {
  try {
    const { readFileSync } = await import('node:fs');
    const { homedir } = await import('node:os');
    HF_TOKEN = readFileSync(`${homedir()}/.cache/huggingface/token`, 'utf8').trim() || null;
  } catch {
    // anonymous
  }
}

function hfHeaders(url) {
  if (!HF_TOKEN) return undefined;
  try {
    const host = new URL(url).hostname;
    if (host === 'huggingface.co' || host.endsWith('.huggingface.co')) {
      return { Authorization: `Bearer ${HF_TOKEN}` };
    }
  } catch {
    // ignore
  }
  return undefined;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
    headers: hfHeaders(url),
  });
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

async function downloadImage(url, destBase, minSide) {
  for (const ext of ['jpg', 'png', 'webp']) {
    try {
      await access(`${destBase}.${ext}`);
      return true;
    } catch {
      // try next
    }
  }
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
    headers: hfHeaders(url),
  });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const type = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 4096) throw new Error('too small');
  if (minSide) {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(buf).metadata();
    if (Math.min(meta.width || 0, meta.height || 0) < minSide) return false;
  }
  await writeFile(`${destBase}.${extToUse(url, type)}`, buf);
  return true;
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

  try {
    const existing = (await readdir(dir)).filter((f) => f.startsWith(`${spec.name}-`)).length;
    if (existing >= spec.count) {
      console.log(`[${spec.name}] already complete (${existing}/${spec.count}), skipping`);
      return;
    }
  } catch {
    // empty
  }

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
      const rowName = spec.nameByRow
        ? `${spec.name}-${row.row_idx ?? offset + fromThisOffset}`
        : null;
      if (spec.urlColumn) {
        const url = spec.urlColumn
          .split('.')
          .reduce((v, k) => (v == null ? v : v[k]), row.row);
        if (typeof url !== 'string' || !url) continue;
        const src = spec.urlParam
          ? `${url}${url.includes('?') ? '&' : '?'}${spec.urlParam}`
          : url;
        jobs.push({
          src,
          destBase: join(dir, rowName ?? `${spec.name}-${String(seq++).padStart(5, '0')}`),
        });
        fromThisOffset++;
        continue;
      }
      for (const col of spec.columns) {
        if (jobs.length >= spec.count || fromThisOffset >= perOffset) break;
        const src = row.row?.[col]?.src;
        if (!src) continue;
        jobs.push({
          src,
          destBase: join(dir, rowName ?? `${spec.name}-${String(seq++).padStart(5, '0')}`),
        });
        fromThisOffset++;
      }
    }
  }

  let skipped = 0;
  const { done, failed } = await pool(
    jobs,
    (j) =>
      downloadImage(j.src, j.destBase, spec.minSide).then((saved) => {
        if (!saved) skipped++;
      }),
    CONCURRENCY
  );
  const skipNote = skipped ? `, ${skipped} skipped under ${spec.minSide}px` : '';
  console.log(`[${spec.name}] ${done - skipped} downloaded, ${failed} failed${skipNote} (${spec.label})`);
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
