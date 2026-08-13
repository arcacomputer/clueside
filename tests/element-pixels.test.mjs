import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeDimensions,
  shouldTryElementPixels,
  MAX_SHORTEST_EDGE,
  MAX_LONGEST_EDGE,
} from '../src/element-pixels.js';
import { isFetchSkipError } from '../src/analyze-retry.js';

describe('encodeDimensions', () => {
  it('keeps typical web and generator sizes untouched', () => {
    assert.deepEqual(encodeDimensions(1024, 1024), { width: 1024, height: 1024 });
    assert.deepEqual(encodeDimensions(800, 600), { width: 800, height: 600 });
  });

  it('downscales huge photos by shortest edge only', () => {
    const { width, height } = encodeDimensions(8000, 4000);
    assert.equal(height, MAX_SHORTEST_EDGE);
    assert.equal(width, 2048);
  });

  it('downscales panoramas whose shortest edge is already small', () => {
    const { width, height } = encodeDimensions(40000, 500);
    assert.equal(width, MAX_LONGEST_EDGE);
    assert.equal(height, 51);
    assert.ok(width * height < 40000 * 500);
  });
});

describe('shouldTryElementPixels', () => {
  it('rescues unsupported schemes (file:// galleries)', () => {
    assert.equal(
      shouldTryElementPixels({ skipped: true, reason: 'Unsupported URL scheme' }, isFetchSkipError),
      true
    );
  });

  it('rescues fetch failures and timeouts', () => {
    assert.equal(shouldTryElementPixels({ error: 'Image fetch failed (403)' }, isFetchSkipError), true);
    assert.equal(shouldTryElementPixels({ error: 'Image fetch timed out' }, isFetchSkipError), true);
    assert.equal(shouldTryElementPixels({ error: 'Failed to fetch' }, isFetchSkipError), true);
  });

  it('does not rescue intentional skips or inference errors', () => {
    assert.equal(shouldTryElementPixels({ skipped: true, reason: 'Image too small' }, isFetchSkipError), false);
    assert.equal(shouldTryElementPixels({ skipped: true, reason: 'Extension disabled' }, isFetchSkipError), false);
    assert.equal(shouldTryElementPixels({ error: 'Inference timed out' }, isFetchSkipError), false);
    assert.equal(shouldTryElementPixels(null, isFetchSkipError), false);
  });

  it('leaves successful results alone', () => {
    assert.equal(shouldTryElementPixels({ rawScore: 0.4, verdict: 'uncertain' }, isFetchSkipError), false);
  });
});
