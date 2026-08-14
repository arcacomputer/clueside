#!/usr/bin/env node
/**
 * Build a Chrome Web Store zip from dist/.
 * The zip MUST include CommunityForensics onnx/model.onnx so the
 * extension works offline after install. Unpacked GitHub install
 * (npm run fetch-model && npm run build) remains the POIDH path.
 */

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
const RELEASE = join(ROOT, 'release');
const ONNX = join(
  DIST,
  'models',
  'buildborderless',
  'CommunityForensics-DeepfakeDet-ViT',
  'onnx',
  'model.onnx'
);
const MIN_ONNX_BYTES = 10 * 1024 * 1024;

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

function shouldSkip(relPosix) {
  if (relPosix.endsWith('.map')) return true;
  if (relPosix.endsWith('.DS_Store')) return true;
  if (relPosix.startsWith('node_modules/')) return true;
  if (relPosix.startsWith('eval/')) return true;
  if (relPosix.startsWith('tests/')) return true;
  return false;
}

async function walkFiles(dir, acc = []) {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      await walkFiles(full, acc);
    } else if (ent.isFile()) {
      acc.push(full);
    }
  }
  return acc;
}

function toPosix(rel) {
  return rel.split(sep).join('/');
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

async function writeZip(files, zipPath) {
  await mkdir(dirname(zipPath), { recursive: true });
  const out = createWriteStream(zipPath);
  const central = [];
  let offset = 0;

  const write = (buf) =>
    new Promise((resolve, reject) => {
      out.write(buf, (error) => (error ? reject(error) : resolve()));
    });

  for (const abs of files) {
    const rel = toPosix(relative(DIST, abs));
    if (shouldSkip(rel)) continue;

    const data = await readFile(abs);
    const nameBuf = Buffer.from(rel, 'utf8');
    const crc = crc32(data);
    const storeOnnx = rel.endsWith('.onnx');
    const compressed = storeOnnx ? data : zlib.deflateRawSync(data, { level: 6 });
    const useStore = storeOnnx || compressed.length >= data.length;
    const payload = useStore ? data : compressed;
    const method = useStore ? 0 : 8;

    const local = Buffer.concat([
      Buffer.from('PK\u0003\u0004'),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(payload.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
    ]);

    await write(local);
    await write(payload);

    central.push(
      Buffer.concat([
        Buffer.from('PK\u0001\u0002'),
        u16(20),
        u16(20),
        u16(0),
        u16(method),
        u16(0),
        u16(0),
        u32(crc),
        u32(payload.length),
        u32(data.length),
        u16(nameBuf.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBuf,
      ])
    );

    offset += local.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  await write(centralBuf);
  await write(
    Buffer.concat([
      Buffer.from('PK\u0005\u0006'),
      u16(0),
      u16(0),
      u16(central.length),
      u16(central.length),
      u32(centralBuf.length),
      u32(offset),
      u16(0),
    ])
  );

  await new Promise((resolve, reject) => {
    out.once('error', reject);
    out.end(resolve);
  });
}

async function main() {
  console.log('Fetching CommunityForensics ONNX if needed...');
  await run(process.execPath, [join(ROOT, 'scripts/fetch-model.mjs')]);

  console.log('Building dist/...');
  await run(process.execPath, [join(ROOT, 'scripts/generate-icons.mjs')]);
  await run(process.execPath, [join(ROOT, 'scripts/build.mjs')]);

  if (!(await exists(ONNX))) {
    throw new Error(
      `CWS zip requires ${relative(ROOT, ONNX)}. Run npm run fetch-model before packaging.`
    );
  }

  const onnxStat = await stat(ONNX);
  if (onnxStat.size < MIN_ONNX_BYTES) {
    throw new Error(
      `ONNX at ${relative(ROOT, ONNX)} is ${onnxStat.size} bytes (expected ~83MB FP32). Refetch the official model.`
    );
  }

  const DINO_ONNX = join(DIST, 'models', 'Xenova', 'dinov2-small', 'onnx', 'model.onnx');
  const PROBE = join(DIST, 'models', 'probe', 'dino-probe.json');
  if (!(await exists(DINO_ONNX)) || (await stat(DINO_ONNX)).size < MIN_ONNX_BYTES) {
    throw new Error(
      `Zip requires ${relative(ROOT, DINO_ONNX)} (~88MB FP32). Run npm run fetch-model before packaging.`
    );
  }
  if (!(await exists(PROBE))) {
    throw new Error(
      `Zip requires ${relative(ROOT, PROBE)}. The DINO probe head must ship with the extension.`
    );
  }

  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const zipName = `hybrid-ai-image-detector-${pkg.version}.zip`;
  const zipPath = join(RELEASE, zipName);

  const files = await walkFiles(DIST);
  const temporaryDownloads = files.filter((abs) =>
    toPosix(relative(DIST, abs)).includes('.download-')
  );
  if (temporaryDownloads.length) {
    throw new Error('dist/ contains a temporary model download; rebuild from clean assets.');
  }
  const extras = files.filter((abs) => toPosix(relative(DIST, abs)).includes('onnx-community'));
  if (extras.length) {
    throw new Error(
      `dist/ contains leftover models (not CommunityForensics). Rebuild after removing models/onnx-community.`
    );
  }

  await writeZip(files, zipPath);

  const zipStat = await stat(zipPath);
  console.log(`CWS zip: ${relative(ROOT, zipPath)} (${(zipStat.size / (1024 * 1024)).toFixed(1)} MB)`);
  console.log(`Bundled ONNX: ${(onnxStat.size / (1024 * 1024)).toFixed(1)} MB`);
  console.log('Upload this zip in the Chrome Web Store developer dashboard. This is not a listing.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
