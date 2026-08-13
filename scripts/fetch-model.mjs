#!/usr/bin/env node
/**
 * Download ONNX weights and config at build time.
 * Pass --with-binary to also fetch the optional CIFAKE binary head for eval experiments.
 */

import { mkdir, writeFile, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const MODELS = [
  {
    repo: 'onnx-community/ai-source-detector-ONNX',
    files: ['onnx/model_quantized.onnx', 'config.json', 'preprocessor_config.json'],
    dtype: 'q8',
    onnx: 'onnx/model_quantized.onnx',
    role: 'source',
    required: true,
  },
  {
    repo: 'onnx-community/ai-image-detection-ONNX',
    files: ['onnx/model_quantized.onnx', 'config.json', 'preprocessor_config.json'],
    dtype: 'q8',
    onnx: 'onnx/model_quantized.onnx',
    role: 'binary',
    required: false,
  },
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

async function fetchModel({ repo, files, dtype, onnx, role }) {
  const modelDir = join(ROOT, 'models', repo);
  const base = `https://huggingface.co/${repo}/resolve/main`;

  await mkdir(modelDir, { recursive: true });

  for (const file of files) {
    const dest = join(modelDir, file);
    if (await exists(dest)) {
      console.log(`Already present: ${repo}/${file}`);
      continue;
    }
    await download(`${base}/${file}`, dest);
  }

  const manifest = {
    id: repo,
    dtype,
    onnx,
    role,
    fetchedAt: new Date().toISOString(),
  };
  await writeFile(join(modelDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Fetched ${repo} (${role})`);
}

async function main() {
  const withBinary = process.argv.includes('--with-binary');
  for (const model of MODELS) {
    if (!model.required && !withBinary) continue;
    await fetchModel(model);
  }
  console.log('Model fetch complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
