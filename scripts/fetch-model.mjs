#!/usr/bin/env node
/**
 * Download ONNX weights at build time: CommunityForensics ViT (primary
 * head) and DINOv2-small (backbone for the probe head). Everything is
 * bundled into the extension; the installed extension never downloads
 * anything at runtime.
 */

import { mkdir, writeFile, access, rename, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_SPECS, buildModelManifest, modelFileUrl } from './model-specs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function fileMatches(path, file) {
  if (!(await exists(path))) return false;
  const info = await stat(path);
  if (info.size !== file.bytes) return false;
  return (await sha256File(path)) === file.sha256;
}

async function downloadVerified(url, dest, file) {
  console.log(`Downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  }

  const declaredBytes = Number(res.headers.get('content-length') || 0);
  if (declaredBytes && declaredBytes !== file.bytes) {
    throw new Error(
      `Unexpected Content-Length for ${file.path}: ${declaredBytes} (expected ${file.bytes})`
    );
  }

  await mkdir(dirname(dest), { recursive: true });
  const temp = `${dest}.download-${process.pid}-${Date.now()}`;
  try {
    await pipeline(res.body, createWriteStream(temp, { flags: 'wx' }));
    if (!(await fileMatches(temp, file))) {
      const actualBytes = (await stat(temp)).size;
      const actualHash = await sha256File(temp);
      throw new Error(
        `Integrity check failed for ${file.path}: ${actualBytes} bytes, sha256 ${actualHash}`
      );
    }

    await rm(dest, { force: true });
    await rename(temp, dest);
  } finally {
    await rm(temp, { force: true });
  }
}

async function main() {
  for (const model of MODEL_SPECS) {
    const modelDir = join(ROOT, 'models', model.repo);
    await mkdir(modelDir, { recursive: true });

    for (const file of model.files) {
      const dest = join(modelDir, file.path);
      if (await fileMatches(dest, file)) {
        console.log(`Verified: ${model.repo}/${file.path}`);
        continue;
      }
      if (await exists(dest)) {
        console.log(`Replacing unverified file: ${model.repo}/${file.path}`);
      }
      await downloadVerified(modelFileUrl(model, file), dest, file);
    }

    await writeFile(
      join(modelDir, 'manifest.json'),
      `${JSON.stringify(buildModelManifest(model), null, 2)}\n`
    );
  }

  console.log('Model fetch complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
