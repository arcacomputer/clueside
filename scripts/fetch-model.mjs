#!/usr/bin/env node
/**
 * Download ONNX weights at build time: CommunityForensics ViT (primary
 * head) and DINOv2-small (backbone for the probe head). Everything is
 * bundled into the extension; the installed extension never downloads
 * anything at runtime.
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
    repo: 'buildborderless/CommunityForensics-DeepfakeDet-ViT',
    files: ['onnx/model.onnx', 'preprocessor_config.json', 'config.json'],
    manifest: { dtype: 'fp32', onnx: 'onnx/model.onnx', inputSize: 384 },
  },
  {
    repo: 'Xenova/dinov2-small',
    files: ['onnx/model.onnx', 'preprocessor_config.json', 'config.json'],
    manifest: { dtype: 'fp32', onnx: 'onnx/model.onnx', inputSize: 224 },
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

async function main() {
  for (const model of MODELS) {
    const modelDir = join(ROOT, 'models', model.repo);
    const base = `https://huggingface.co/${model.repo}/resolve/main`;
    await mkdir(modelDir, { recursive: true });

    for (const file of model.files) {
      const dest = join(modelDir, file);
      if (await exists(dest)) {
        console.log(`Already present: ${model.repo}/${file}`);
        continue;
      }
      await download(`${base}/${file}`, dest);
    }

    await writeFile(
      join(modelDir, 'manifest.json'),
      JSON.stringify({ id: model.repo, ...model.manifest, fetchedAt: new Date().toISOString() }, null, 2)
    );
  }

  console.log('Model fetch complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
