import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { pillowResize } from '../src/pixel-resize.js';

// The committed fixture is a 4-case subset (downscale RGB, tall 512 target,
// upscale, grayscale) of the full 10-case set generated against Pillow
// 12.3.0. Point PIXEL_RESIZE_GOLDENS at a full goldens.json to run all 10.
const GOLDEN_CANDIDATES = [
  process.env.PIXEL_RESIZE_GOLDENS,
  new URL('./fixtures/goldens.json.gz', import.meta.url).pathname,
].filter(Boolean);

function loadGoldens() {
  for (const path of GOLDEN_CANDIDATES) {
    if (existsSync(path)) {
      const raw = readFileSync(path);
      const text = path.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
      return JSON.parse(text);
    }
  }
  return null;
}

/**
 * Synthetic gradient matching the golden generator formula shape:
 * deterministic per-pixel values across the full byte range.
 */
function gradImage(width, height, channels) {
  const data = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const base = (y * width + x) * channels;
      for (let c = 0; c < channels; c++) {
        data[base + c] = (x * 3 + y * 5 + c * 41) % 256;
      }
    }
  }
  return data;
}

describe('pillowResize goldens', () => {
  const goldens = loadGoldens();

  if (!goldens) {
    console.warn(
      'WARNING: goldens.json not found in any of:\n  ' +
        GOLDEN_CANDIDATES.join('\n  ') +
        '\nSkipping Pillow byte-exact golden tests. Regenerate with the ' +
        'gen_goldens.py script against Pillow 12.3.0.'
    );
    it.skip('goldens.json missing, byte-exact checks skipped', () => {});
    return;
  }

  for (const entry of goldens) {
    it(`matches Pillow byte-exact: ${entry.name} (${entry.mode} ${entry.inW}x${entry.inH} -> ${entry.outW}x${entry.outH})`, () => {
      const channels = entry.mode === 'L' ? 1 : 3;
      const input = Buffer.from(entry.input_b64, 'base64');
      const expected = Buffer.from(entry.output_b64, 'base64');
      assert.equal(input.length, entry.inW * entry.inH * channels);
      assert.equal(expected.length, entry.outW * entry.outH * channels);

      const actual = pillowResize(
        new Uint8Array(input.buffer, input.byteOffset, input.length),
        entry.inW,
        entry.inH,
        channels,
        entry.outW,
        entry.outH
      );

      assert.equal(actual.length, expected.length);
      assert.ok(
        Buffer.from(actual.buffer, actual.byteOffset, actual.length).equals(expected),
        `bytes differ from Pillow ${entry.pillow_version} for ${entry.name}`
      );
    });
  }
});

describe('pillowResize identity', () => {
  it('same-dims resize returns identical bytes', () => {
    const width = 123;
    const height = 77;
    const input = gradImage(width, height, 3);
    const out = pillowResize(input, width, height, 3, width, height);
    assert.equal(out.length, input.length);
    assert.deepEqual(Array.from(out), Array.from(input));
  });
});

describe('pillowResize flat field', () => {
  it('constant image stays exactly constant at any target size', () => {
    const width = 61;
    const height = 43;
    const value = 137;
    const input = new Uint8Array(width * height * 3).fill(value);
    for (const [outW, outH] of [
      [17, 11],
      [200, 300],
      [61, 200],
      [1, 1],
    ]) {
      const out = pillowResize(input, width, height, 3, outW, outH);
      assert.equal(out.length, outW * outH * 3);
      for (let i = 0; i < out.length; i++) {
        assert.equal(out[i], value, `pixel ${i} drifted at ${outW}x${outH}`);
      }
    }
  });
});

describe('pillowResize channels', () => {
  it('handles 1-channel input', () => {
    const input = gradImage(50, 40, 1);
    const out = pillowResize(input, 50, 40, 1, 30, 20);
    assert.equal(out.length, 30 * 20 * 1);
  });

  it('handles 4-channel input and keeps alpha=255 exactly 255', () => {
    const width = 48;
    const height = 36;
    const input = gradImage(width, height, 4);
    for (let i = 3; i < input.length; i += 4) {
      input[i] = 255;
    }
    const out = pillowResize(input, width, height, 4, 91, 63);
    assert.equal(out.length, 91 * 63 * 4);
    for (let i = 3; i < out.length; i += 4) {
      assert.equal(out[i], 255, `alpha drifted at index ${i}`);
    }
  });
});

describe('pillowResize dimension errors', () => {
  const input = new Uint8Array(4 * 4 * 3);

  it('throws on non-positive dims', () => {
    assert.throws(() => pillowResize(input, 0, 4, 3, 2, 2));
    assert.throws(() => pillowResize(input, 4, -1, 3, 2, 2));
    assert.throws(() => pillowResize(input, 4, 4, 3, 0, 2));
    assert.throws(() => pillowResize(input, 4, 4, 3, 2, -5));
  });

  it('throws on non-integer dims', () => {
    assert.throws(() => pillowResize(input, 4.5, 4, 3, 2, 2));
    assert.throws(() => pillowResize(input, 4, 4, 3, 2.2, 2));
  });

  it('throws on invalid channel counts', () => {
    assert.throws(() => pillowResize(input, 4, 4, 0, 2, 2));
    assert.throws(() => pillowResize(input, 4, 4, 5, 2, 2));
  });

  it('throws when data is shorter than the claimed dims', () => {
    assert.throws(() => pillowResize(new Uint8Array(10), 4, 4, 3, 2, 2));
  });
});

describe('pillowResize benchmark', () => {
  it('logs 4000x3000x4 -> 587x440 timing (no assertion)', () => {
    const width = 4000;
    const height = 3000;
    const input = new Uint8Array(width * height * 4);
    for (let i = 0; i < input.length; i++) {
      input[i] = (i * 2654435761) & 255;
    }
    const start = performance.now();
    const out = pillowResize(input, width, height, 4, 587, 440);
    const ms = performance.now() - start;
    assert.equal(out.length, 587 * 440 * 4);
    console.log(`pillowResize 4000x3000x4 -> 587x440: ${ms.toFixed(1)} ms`);
  });
});
