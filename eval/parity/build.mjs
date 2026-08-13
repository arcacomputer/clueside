#!/usr/bin/env node

/** Bundle the parity harness entry with the same esbuild the product uses. */

import { build } from 'esbuild';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(__dirname, 'parity-entry.mjs')],
  outfile: join(__dirname, 'bundle.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome110',
  logLevel: 'info',
});
