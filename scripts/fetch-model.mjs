#!/usr/bin/env node
/**
 * Download CommunityForensics ONNX weights at build time.
 */

import { mkdir, writeFile, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const REPO = 'buildborderless/CommunityForensics-DeepfakeDet-ViT';
const MODEL_DIR = join(ROOT, 'models', REPO);
const BASE = `https://huggingface.co/${REPO}/resolve/main`;

const FILES = ['onnx/model.onnx', 'preprocessor_config.json', 'config.json'];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function download(url, dest) {
  console.log(`Downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  }
  await mkdir(dirname(dest), { recursive: true });
  await pipeline(res.body, createWriteStream(dest));
}

async function main() {
  await mkdir(MODEL_DIR, { recursive: true });

  for (const file of FILES) {
    const dest = join(MODEL_DIR, file);
    if (await exists(dest)) {
      console.log(`Already present: ${REPO}/${file}`);
      continue;
    }
    await download(`${BASE}/${file}`, dest);
  }

  const manifest = {
    id: REPO,
    dtype: 'fp32',
    onnx: 'onnx/model.onnx',
    inputSize: 384,
    fetchedAt: new Date().toISOString(),
  };
  await writeFile(join(MODEL_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('Model fetch complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
