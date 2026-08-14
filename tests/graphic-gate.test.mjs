import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeGraphicPixels } from '../src/graphic-gate.js';

function rgbaBuffer(width, height, fillFn) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b, a = 255] = fillFn(x, y);
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = a;
    }
  }
  return rgba;
}

describe('analyzeGraphicPixels', () => {
  it('flags flat UI panels with a tiny palette', () => {
    const rgba = rgbaBuffer(64, 64, (x) => {
      if (x < 32) return [30, 30, 30];
      return [200, 200, 200];
    });
    const stats = analyzeGraphicPixels(rgba, 64, 64);
    assert.equal(stats.isGraphic, true);
    assert.ok(stats.flatFrac > 0.62);
  });

  it('does not flag noisy photo-like pixels', () => {
    const rgba = rgbaBuffer(64, 64, (x, y) => [
      (x * 17 + y * 31) % 256,
      (x * 13 + y * 7) % 256,
      (x * 5 + y * 19) % 256,
    ]);
    const stats = analyzeGraphicPixels(rgba, 64, 64);
    assert.equal(stats.isGraphic, false);
  });

  it('flags a flat catalog band with few quantized colors', () => {
    const rgba = rgbaBuffer(80, 80, (x, y) => {
      const band = Math.floor(y / 20);
      const colors = [
        [240, 240, 240],
        [20, 20, 20],
        [0, 120, 215],
        [255, 185, 0],
      ];
      return colors[band];
    });
    const stats = analyzeGraphicPixels(rgba, 80, 80);
    assert.equal(stats.isGraphic, true);
  });
});
