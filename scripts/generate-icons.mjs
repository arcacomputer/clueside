#!/usr/bin/env node
/** Generate simple 16/48/128 PNG icons for the extension. */

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'icons');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function createPng(size) {
  const width = size;
  const height = size;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  const edge = size * 0.08;
  const radius = size * 0.2;
  const stroke = Math.max(1, Math.round(size * 0.055));
  const frameMin = size * 0.26;
  const frameMax = size * 0.74;
  const arm = size * 0.15;
  const centerMin = size * 0.39;
  const centerMax = size * 0.61;

  function insideRoundedSquare(x, y) {
    const left = edge;
    const right = size - edge;
    const top = edge;
    const bottom = size - edge;
    const cx = Math.max(left + radius, Math.min(x, right - radius));
    const cy = Math.max(top + radius, Math.min(y, bottom - radius));
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  }

  function inViewfinder(x, y) {
    const horizontal =
      (Math.abs(y - frameMin) <= stroke || Math.abs(y - frameMax) <= stroke) &&
      ((x >= frameMin && x <= frameMin + arm) || (x <= frameMax && x >= frameMax - arm));
    const vertical =
      (Math.abs(x - frameMin) <= stroke || Math.abs(x - frameMax) <= stroke) &&
      ((y >= frameMin && y <= frameMin + arm) || (y <= frameMax && y >= frameMax - arm));
    return horizontal || vertical;
  }

  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1) + 1;
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const i = row + x * 4;
      let color = [0, 0, 0, 0];
      if (insideRoundedSquare(px, py)) color = [21, 23, 20, 255];
      if (insideRoundedSquare(px, py) && inViewfinder(px, py)) color = [244, 240, 231, 255];
      if (px >= centerMin && px <= centerMax && py >= centerMin && py <= centerMax) {
        color = [255, 90, 54, 255];
      }
      [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]] = color;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  for (const size of [16, 48, 128]) {
    await writeFile(join(OUT, `icon${size}.png`), createPng(size));
  }
  console.log('Icons written to icons/');
}

main();
