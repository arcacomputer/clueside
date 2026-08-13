#!/usr/bin/env node

/**
 * Dev-only static server for the parity harness.
 *
 * Usage: node eval/parity/server.mjs <bench-dir> [port] [limit-per-class]
 *
 * Routes:
 *   /            parity.html
 *   /bundle.js   esbuild output (run eval/parity/build.mjs first)
 *   /ort/*       onnxruntime-web dist (wasm binaries)
 *   /models-file the ONNX model
 *   /manifest.json stratified sample of bench images
 *   /bench/*     bench images
 */

import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_ID, MODEL_ONNX_PATH } from '../../src/models.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const benchDir = process.argv[2];
const port = Number(process.argv[3] || 8787);
const perClass = Number(process.argv[4] || 24);
if (!benchDir) {
  console.error('Usage: node eval/parity/server.mjs <bench-dir> [port] [limit-per-class]');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.onnx': 'application/octet-stream',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

async function buildManifest() {
  const manifest = [];
  for (const label of ['ai', 'real']) {
    let files;
    try {
      files = (await readdir(join(benchDir, label))).filter((f) => MIME[extname(f).toLowerCase()]);
    } catch {
      continue;
    }
    // Stratified: spread across sources by sorting then striding.
    files.sort();
    const step = Math.max(1, Math.floor(files.length / perClass));
    for (let i = 0; i < files.length && manifest.filter((m) => m.label === label).length < perClass; i += step) {
      manifest.push({ name: files[i], label, url: `/bench/${label}/${encodeURIComponent(files[i])}` });
    }
  }
  return manifest;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let filePath = null;
    const p = url.pathname;

    if (p === '/' || p === '/index.html') filePath = join(__dirname, 'parity.html');
    else if (p === '/bundle.js') filePath = join(__dirname, 'bundle.js');
    else if (p === '/models-file') filePath = join(ROOT, 'models', MODEL_ID, MODEL_ONNX_PATH);
    else if (p === '/dino-file') filePath = join(ROOT, 'models', 'Xenova', 'dinov2-small', 'onnx', 'model.onnx');
    else if (p === '/probe.json') filePath = join(ROOT, 'models', 'probe', 'dino-probe.json');
    else if (p === '/manifest.json') {
      const manifest = await buildManifest();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(manifest));
      return;
    } else if (p.startsWith('/ort/')) {
      filePath = join(ROOT, 'node_modules', 'onnxruntime-web', 'dist', p.slice('/ort/'.length));
    } else if (p.startsWith('/bench/')) {
      filePath = join(benchDir, decodeURIComponent(p.slice('/bench/'.length)));
    }

    if (!filePath) {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    const data = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    });
    res.end(data);
  } catch (err) {
    res.writeHead(500);
    res.end(String(err?.message || err));
  }
});

server.listen(port, () => {
  console.log(`parity server on http://localhost:${port}/ (bench: ${benchDir})`);
});
