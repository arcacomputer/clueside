#!/usr/bin/env node

/**
 * Make "web-realistic" copies of a labeled benchmark: max dimension 800,
 * JPEG quality 78 (typical CDN/CMS pipeline). macOS `sips` only.
 *
 * Usage: node eval/degrade.mjs <in-dir> <out-dir>
 */

import { mkdir, readdir } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const [inDir, outDir] = process.argv.slice(2);
if (!inDir || !outDir) {
  console.error('Usage: node eval/degrade.mjs <in-dir> <out-dir>');
  process.exit(1);
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

for (const label of ['ai', 'real']) {
  const src = join(inDir, label);
  const dst = join(outDir, label);
  await mkdir(dst, { recursive: true });
  let files;
  try {
    files = await readdir(src);
  } catch {
    continue;
  }
  let done = 0;
  for (const file of files) {
    if (!IMAGE_EXT.has(extname(file).toLowerCase())) continue;
    const name = basename(file, extname(file)) + '.jpg';
    try {
      await run('sips', ['-Z', '800', '-s', 'format', 'jpeg', '-s', 'formatOptions', '78', join(src, file), '--out', join(dst, name)], { timeout: 30000 });
      done++;
    } catch (err) {
      console.error(`degrade failed: ${file}: ${err.message}`);
    }
  }
  console.log(`${label}: ${done} degraded copies`);
}
