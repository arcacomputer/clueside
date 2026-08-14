import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  dinoResizeDimensions,
  dinoPoolFeatures,
  dinoProbeScore,
  dinoPackedRgbToCHW,
  dinoPreprocessRawImage,
  DINO_CROP_SIZE,
} from '../src/dino.js';
import { fuseNeuralScores } from '../src/fuse.js';

describe('dinoResizeDimensions', () => {
  it('resizes shortest edge to 256 preserving aspect', () => {
    assert.deepEqual(dinoResizeDimensions(1024, 768), { width: 341, height: 256 });
    assert.deepEqual(dinoResizeDimensions(768, 1024), { width: 256, height: 341 });
    assert.deepEqual(dinoResizeDimensions(256, 256), { width: 256, height: 256 });
  });

  it('rejects invalid dimensions', () => {
    assert.throws(() => dinoResizeDimensions(0, 100));
  });
});

describe('dinoPoolFeatures', () => {
  it('concatenates CLS with mean of patch tokens', () => {
    // 3 tokens (CLS + 2 patches), hidden size 2
    const hidden = Float32Array.from([
      1, 2, // CLS
      3, 4, // patch 1
      5, 6, // patch 2
    ]);
    const pooled = dinoPoolFeatures(hidden, 3, 2);
    assert.deepEqual([...pooled], [1, 2, 4, 5]);
  });
});

describe('dinoProbeScore', () => {
  const probe = {
    dims: 2,
    featureMean: [1, 1],
    featureStd: [2, 2],
    weights: [1, -1],
    bias: 0,
  };

  it('applies standardization then logistic', () => {
    // features [3, 1] -> standardized [1, 0] -> z = 1 -> sigmoid(1)
    const p = dinoProbeScore([3, 1], probe);
    assert.ok(Math.abs(p - 1 / (1 + Math.exp(-1))) < 1e-9);
  });

  it('rejects dimension mismatch', () => {
    assert.throws(() => dinoProbeScore([1, 2, 3], probe));
  });
});

describe('dinoPackedRgbToCHW', () => {
  it('produces CHW planes with ImageNet normalization', () => {
    const plane = DINO_CROP_SIZE * DINO_CROP_SIZE;
    const rgba = new Uint8Array(plane * 4);
    rgba.fill(255); // white
    const chw = dinoPackedRgbToCHW(rgba, 4);
    assert.equal(chw.length, 3 * plane);
    // (1 - 0.485) / 0.229
    assert.ok(Math.abs(chw[0] - (1 - 0.485) / 0.229) < 1e-6);
    assert.ok(Math.abs(chw[plane] - (1 - 0.456) / 0.224) < 1e-6);
  });
});

describe('dinoPreprocessRawImage', () => {
  it('uses the shared 256-short-edge center crop', async () => {
    const plane = DINO_CROP_SIZE * DINO_CROP_SIZE;
    let resizeArgs = null;
    let cropArgs = null;
    const rawImage = {
      width: 1024,
      height: 768,
      async resize(width, height) {
        resizeArgs = [width, height];
        return {
          async crop(box) {
            cropArgs = box;
            return {
              width: DINO_CROP_SIZE,
              height: DINO_CROP_SIZE,
              channels: 3,
              data: new Uint8Array(plane * 3),
            };
          },
        };
      },
    };

    const chw = await dinoPreprocessRawImage(rawImage);
    assert.deepEqual(resizeArgs, [341, 256]);
    assert.deepEqual(cropArgs, [58, 16, 281, 239]);
    assert.equal(chw.length, 3 * plane);
  });
});

describe('fuseNeuralScores', () => {
  it('trusts CF when it is already confident AI', () => {
    assert.equal(fuseNeuralScores(0.8, 0.1), 0.8);
    assert.equal(fuseNeuralScores(0.7, 0.99), 0.7);
  });

  it('does not let saturated DINO override a near-zero CF', () => {
    assert.equal(fuseNeuralScores(0.02, 0.99), 0.02);
    assert.equal(fuseNeuralScores(0.149, 1), 0.149);
  });

  it('lets DINO lift uncertain CF scores', () => {
    assert.equal(fuseNeuralScores(0.5, 0.9), 0.9);
    assert.equal(fuseNeuralScores(0.55, 0.7), 0.7);
  });

  it('falls back to CF when dino head is unavailable', () => {
    assert.equal(fuseNeuralScores(0.42, null), 0.42);
    assert.equal(fuseNeuralScores(0.42, NaN), 0.42);
  });

  it('clamps out-of-range scores', () => {
    assert.equal(fuseNeuralScores(1.5, -0.5), 1);
    assert.equal(fuseNeuralScores(-1, 0.5), 0);
  });
});
