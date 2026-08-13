import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bytesToBase64, base64ToBytes, toArrayBuffer } from '../src/bytes.js';

describe('byte transport encoding', () => {
  it('round-trips a small payload', () => {
    const original = new Uint8Array([0, 1, 2, 128, 255, 137, 80, 78, 71]);
    const decoded = base64ToBytes(bytesToBase64(original));
    assert.deepEqual([...decoded], [...original]);
  });

  it('round-trips an ArrayBuffer input', () => {
    const original = new Uint8Array([255, 216, 255, 224]).buffer;
    const decoded = base64ToBytes(bytesToBase64(original));
    assert.deepEqual([...decoded], [255, 216, 255, 224]);
  });

  it('round-trips a payload larger than one encoding chunk', () => {
    const original = new Uint8Array(200_000);
    for (let i = 0; i < original.length; i++) {
      original[i] = (i * 31 + 7) % 256;
    }
    const decoded = base64ToBytes(bytesToBase64(original));
    assert.equal(decoded.length, original.length);
    assert.deepEqual([...decoded.subarray(0, 64)], [...original.subarray(0, 64)]);
    assert.deepEqual([...decoded.subarray(-64)], [...original.subarray(-64)]);
  });

  it('round-trips an empty payload', () => {
    const decoded = base64ToBytes(bytesToBase64(new Uint8Array(0)));
    assert.equal(decoded.length, 0);
  });

  it('rejects non-string input to base64ToBytes', () => {
    assert.throws(() => base64ToBytes(undefined), /Expected base64 string/);
  });
});

describe('toArrayBuffer', () => {
  it('returns the same ArrayBuffer when given one', () => {
    const original = new Uint8Array([1, 2, 3]).buffer;
    assert.equal(toArrayBuffer(original), original);
  });

  it('copies a Uint8Array view into a standalone buffer', () => {
    const decoded = toArrayBuffer(new Uint8Array([137, 80, 78, 71]));
    assert.ok(decoded instanceof ArrayBuffer);
    assert.deepEqual([...new Uint8Array(decoded)], [137, 80, 78, 71]);
  });

  it('throws a clear error for undefined input', () => {
    assert.throws(() => toArrayBuffer(undefined), /No image bytes received/);
  });

  it('throws for an empty payload', () => {
    assert.throws(() => toArrayBuffer(new ArrayBuffer(0)), /No image bytes to analyze/);
  });
});
