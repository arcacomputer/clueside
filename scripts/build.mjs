#!/usr/bin/env node

import { cp, mkdir, rm, readFile, writeFile, access } from 'node:fs/promises';
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

const REQUIRED_WASM = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
];

const OPTIONAL_WASM = [
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
];

async function mustExist(path, label) {
  try {
    await access(path);
  } catch {
    throw new Error(`Missing required build asset: ${label} (${path})`);
  }
}

async function copyWasm() {
  const ortPkg = join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
  await mkdir(LIB, { recursive: true });

  for (const file of REQUIRED_WASM) {
    const src = join(ortPkg, file);
    await mustExist(src, `onnxruntime-web ${file}`);
    await cp(src, join(LIB, file));
  }

  for (const file of OPTIONAL_WASM) {
    const src = join(ortPkg, file);
    try {
      await access(src);
      await cp(src, join(LIB, file));
    } catch {
      // Optional ORT wasm variants.
    }
  }

  const c2paWasm = join(
    ROOT,
    'node_modules',
    '@contentauth',
    'c2pa-web',
    'dist',
    'resources',
    'c2pa_bg.wasm'
  );
  const c2paWorker = join(ROOT, 'node_modules', '@contentauth', 'c2pa-web', 'dist', 'c2pa_worker.js');
  await mustExist(c2paWasm, 'c2pa_bg.wasm');
  await mustExist(c2paWorker, 'c2pa_worker.js');
  await cp(c2paWasm, join(LIB, 'c2pa_bg.wasm'));
  await cp(c2paWorker, join(LIB, 'c2pa_worker.js'));
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

  const modelDirs = [
    ['buildborderless', 'CommunityForensics-DeepfakeDet-ViT'],
    ['Xenova', 'dinov2-small'],
  ];

  for (const parts of modelDirs) {
    const srcModels = join(ROOT, 'models', ...parts);
    const destModels = join(MODELS, ...parts);
    try {
      await mustExist(join(srcModels, 'onnx', 'model.onnx'), `${parts.join('/')} onnx/model.onnx`);
      await cp(srcModels, destModels, { recursive: true });
    } catch (err) {
      await mkdir(destModels, { recursive: true });
      console.warn(
        `Warning: ${parts.join('/')} weights missing. Run npm run fetch-model before loading or packaging.`
      );
      if (process.env.REQUIRE_MODEL === '1') throw err;
    }
  }

  const probeSrc = join(ROOT, 'models', 'probe', 'dino-probe.json');
  try {
    await mustExist(probeSrc, 'models/probe/dino-probe.json');
    await cp(probeSrc, join(MODELS, 'probe', 'dino-probe.json'));
  } catch (err) {
    console.warn('Warning: dino-probe.json missing; DINO head will be disabled in this build.');
    if (process.env.REQUIRE_MODEL === '1') throw err;
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
