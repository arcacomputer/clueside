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
  it('resizes to the 256 short edge and center-crops 224 via pillowResize', async () => {
    const plane = DINO_CROP_SIZE * DINO_CROP_SIZE;
    // Constant-value pixels survive Pillow bicubic exactly, so a flat
    // image proves the resize plus window-crop path end to end.
    const rawImage = {
      width: 1024,
      height: 768,
      channels: 3,
      data: new Uint8Array(1024 * 768 * 3).fill(200),
    };

    const chw = await dinoPreprocessRawImage(rawImage);
    assert.equal(chw.length, 3 * plane);
    // (200/255 - 0.485) / 0.229 in the R plane, everywhere.
    const expectedR = (200 / 255 - 0.485) / 0.229;
    assert.ok(Math.abs(chw[0] - expectedR) < 1e-6);
    assert.ok(Math.abs(chw[plane - 1] - expectedR) < 1e-6);
  });

  it('handles grayscale sources without NaN poisoning', async () => {
    const rawImage = {
      width: 512,
      height: 512,
      channels: 1,
      data: new Uint8Array(512 * 512).fill(128),
    };
    const chw = await dinoPreprocessRawImage(rawImage);
    for (let i = 0; i < 10; i++) assert.ok(Number.isFinite(chw[i]));
  });
});

describe('fuseNeuralScores', () => {
  it('trusts CF when it is already confident AI', () => {
    assert.equal(fuseNeuralScores(0.8, 0.1), 0.8);
    assert.equal(fuseNeuralScores(0.7, 0.99), 0.7);
  });

  it('does not let saturated DINO override a hard-zero CF', () => {
    // CF hard zeros mark confident reals; no rescue tier may touch them.
    assert.equal(fuseNeuralScores(0.0, 0.9999), 0.0);
    assert.equal(fuseNeuralScores(0.0004, 0.9999), 0.0004);
    // Below the CF floor, high-but-unsaturated DINO still cannot rescue.
    assert.equal(fuseNeuralScores(0.015, 0.99), 0.015);
  });

  it('ignores DINO rescue when it is not high-confidence', () => {
    assert.equal(fuseNeuralScores(0.45, 0.66), 0.45);
    assert.equal(fuseNeuralScores(0.55, 0.69), 0.55);
  });

  it('lets DINO lift uncertain CF scores', () => {
    assert.equal(fuseNeuralScores(0.5, 0.9), 0.9);
    assert.equal(fuseNeuralScores(0.55, 0.7), 0.7);
  });

  it('only rescues low CF scores with near-saturated DINO', () => {
    assert.equal(fuseNeuralScores(0.05, 0.99), 0.99);
    assert.equal(fuseNeuralScores(0.05, 0.89), 0.05);
    assert.equal(fuseNeuralScores(0.25, 0.75), 0.75);
    assert.equal(fuseNeuralScores(0.25, 0.65), 0.25);
    // Sub-floor tier: faintly awake CF plus saturated DINO rescues.
    assert.equal(fuseNeuralScores(0.01, 0.996), 0.996);
    assert.equal(fuseNeuralScores(0.01, 0.99), 0.01);
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
