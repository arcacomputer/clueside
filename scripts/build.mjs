#!/usr/bin/env node

import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
const LIB = join(DIST, 'lib');
const MODELS = join(DIST, 'models');

const ENTRY_POINTS = {
  'background.js': join(ROOT, 'src/background.js'),
  'content.js': join(ROOT, 'src/content.js'),
  'popup.js': join(ROOT, 'src/popup.js'),
  'offscreen.js': join(ROOT, 'src/offscreen.js'),
};

async function copyWasm() {
  const ortPkg = join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
  const wasmFiles = [
    'ort-wasm-simd-threaded.wasm',
    'ort-wasm-simd-threaded.jsep.wasm',
    'ort-wasm-simd-threaded.asyncify.wasm',
    'ort-wasm-simd-threaded.mjs',
    'ort-wasm-simd-threaded.jsep.mjs',
    'ort-wasm-simd-threaded.asyncify.mjs',
  ];

  await mkdir(LIB, { recursive: true });

  for (const file of wasmFiles) {
    const src = join(ortPkg, file);
    try {
      await cp(src, join(LIB, file));
    } catch {
      // Some ORT builds omit optional wasm variants.
    }
  }

  const transformersWasm = join(
    ROOT,
    'node_modules',
    '@huggingface',
    'transformers',
    'dist',
    'ort-wasm-simd-threaded.wasm'
  );
  try {
    await cp(transformersWasm, join(LIB, 'ort-wasm-simd-threaded.wasm'));
  } catch {
    // fallback to onnxruntime-web copy
  }
}

async function copyStatic() {
  const staticFiles = [
    ['src/offscreen.html', 'offscreen.html'],
    ['src/popup.html', 'popup.html'],
    ['src/overlay.css', 'overlay.css'],
    ['manifest.json', 'manifest.json'],
  ];

  for (const [src, dest] of staticFiles) {
    await cp(join(ROOT, src), join(DIST, dest));
  }

  for (const size of [16, 48, 128]) {
    await cp(join(ROOT, 'icons', `icon${size}.png`), join(DIST, `icons/icon${size}.png`));
  }

  const srcModels = join(ROOT, 'models');
  try {
    await cp(srcModels, MODELS, { recursive: true });
  } catch {
    await mkdir(MODELS, { recursive: true });
    console.warn('Warning: models/ missing. Run npm run fetch-model before loading the extension.');
  }
}

async function bundleJs() {
  for (const [outfile, entryPoint] of Object.entries(ENTRY_POINTS)) {
    await esbuild.build({
      entryPoints: [entryPoint],
      outfile: join(DIST, outfile),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['chrome120'],
      sourcemap: true,
      define: {
        'process.env.NODE_ENV': '"production"',
      },
      logLevel: 'info',
    });
  }
}

async function patchManifest() {
  const manifestPath = join(DIST, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.version = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

async function main() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await mkdir(join(DIST, 'icons'), { recursive: true });

  await bundleJs();
  await copyWasm();
  await copyStatic();
  await patchManifest();

  console.log('Build complete: dist/');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
