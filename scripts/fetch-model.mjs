#!/usr/bin/env node
/**
 * Download ai-source-detector ONNX weights and config at build time.
 * After this script runs, the unpacked extension works fully offline.
 */

import { mkdir, writeFile, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const MODELS_DIR = join(ROOT, 'models', 'onnx-community', 'ai-source-detector-ONNX');

const REPO = 'onnx-community/ai-source-detector-ONNX';
const BASE = `https://huggingface.co/${REPO}/resolve/main`;

const FILES = [
  'onnx/model_quantized.onnx',
  'config.json',
  'preprocessor_config.json',
];

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
  await mkdir(MODELS_DIR, { recursive: true });

  for (const file of FILES) {
    const dest = join(MODELS_DIR, file);
    if (await exists(dest)) {
      console.log(`Already present: ${file}`);
      continue;
    }
    await download(`${BASE}/${file}`, dest);
  }

  const manifest = {
    id: REPO,
    dtype: 'q8',
    onnx: 'onnx/model_quantized.onnx',
    fetchedAt: new Date().toISOString(),
  };
  await writeFile(join(MODELS_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('Model fetch complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
