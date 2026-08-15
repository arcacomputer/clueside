import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cropOrigins,
  cropPackedPixels,
  needsCanvasFallback,
  packedRgbToCHW,
  preprocessBitmap,
  preprocessBitmapViews,
  preprocessRawImage,
  preprocessRawImageViews,
  resizeDimensions,
  ttaViewPlan,
} from '../src/clip-preprocess.js';
import { pillowResize } from '../src/pixel-resize.js';
import { MAX_CANVAS_SIDE, MAX_IMAGE_PIXELS } from '../src/image-limits.js';

describe('needsCanvasFallback', () => {
  it('accepts ordinary photo dimensions', () => {
    assert.equal(needsCanvasFallback(4000, 3000), false);
    assert.equal(needsCanvasFallback(8192, 8192), false);
  });

  it('falls back above the decoded pixel cap', () => {
    assert.equal(needsCanvasFallback(8193, 8192), true);
    assert.equal(needsCanvasFallback(1, MAX_IMAGE_PIXELS + 1), true);
  });

  it('falls back when a side exceeds the canvas limit even in-cap', () => {
    // 100,000 x 500 is only 50 MiPixels but a native canvas that wide
    // silently reads back transparent black in Chrome.
    assert.equal(needsCanvasFallback(100000, 500), true);
    assert.equal(needsCanvasFallback(500, MAX_CANVAS_SIDE + 1), true);
    assert.equal(needsCanvasFallback(MAX_CANVAS_SIDE, 1), false);
  });
});
import { CROP_SIZE, SHORTEST_EDGE, TTA_EXTRA_SHORTEST_EDGE } from '../src/models.js';

function seededPixels(length) {
  const data = new Uint8ClampedArray(length);
  let state = 0x2545f491;
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    data[i] = state & 0xff;
  }
  return data;
}

function fakeRawImage(width, height, channels) {
  return { data: seededPixels(width * height * channels), width, height, channels };
}

describe('cropOrigins', () => {
  it('returns five distinct origins on a 440 square', () => {
    const origins = cropOrigins(440, 440);
    assert.equal(origins.length, 5);
    assert.equal(origins[0].name, 'center');
    assert.equal(origins[0].sx, Math.floor((440 - CROP_SIZE) / 2));
    const keys = new Set(origins.map((o) => `${o.sx},${o.sy}`));
    assert.equal(keys.size, 5);
  });

  it('returns only center when the resized image is already 384', () => {
    const origins = cropOrigins(384, 384);
    assert.deepEqual(origins, [{ name: 'center', sx: 0, sy: 0 }]);
  });

  it('keeps corners on a tall 440-wide resize', () => {
    const origins = cropOrigins(440, 800);
    assert.equal(origins.length, 5);
    assert.equal(origins.find((o) => o.name === 'bl').sy, 800 - CROP_SIZE);
  });
});

describe('ttaViewPlan', () => {
  it('plans 440 center+corners then a 512 center (six views on a square)', () => {
    const plan = ttaViewPlan(1024, 1024);
    assert.equal(plan.length, 6);
    assert.equal(plan[0].name, 'center');
    assert.equal(plan[0].shortestEdge, SHORTEST_EDGE);
    assert.equal(plan[0].resizedW, 440);
    assert.ok(plan.some((v) => v.name === 'tl'));
    const extra = plan[plan.length - 1];
    assert.equal(extra.name, 'center_512');
    assert.equal(extra.shortestEdge, TTA_EXTRA_SHORTEST_EDGE);
    assert.equal(extra.resizedW, 512);
    assert.equal(extra.sx, Math.floor((512 - CROP_SIZE) / 2));
  });

  it('never treats a 384 crop as the resize source (no double scale)', () => {
    const plan = ttaViewPlan(1024, 768);
    for (const step of plan) {
      assert.ok(step.resizedW >= CROP_SIZE);
      assert.ok(step.resizedH >= CROP_SIZE);
      assert.ok(step.resizedW === step.shortestEdge || step.resizedH === step.shortestEdge);
      assert.notEqual(step.resizedW, CROP_SIZE);
    }
  });
});

describe('resizeDimensions', () => {
  it('preserves aspect ratio at shortest 440', () => {
    const dim = resizeDimensions(1024, 2048, 440);
    assert.equal(dim.width, 440);
    assert.equal(dim.height, 880);
  });
});

describe('cropPackedPixels', () => {
  it('window-copies the exact source pixels', () => {
    const width = CROP_SIZE + 20;
    const height = CROP_SIZE + 10;
    const channels = 3;
    const data = seededPixels(width * height * channels);
    const crop = cropPackedPixels(data, width, height, channels, 5, 7);

    assert.equal(crop.length, CROP_SIZE * CROP_SIZE * channels);
    for (const [x, y] of [[0, 0], [CROP_SIZE - 1, 0], [0, CROP_SIZE - 1], [17, 231]]) {
      const src = ((7 + y) * width + 5 + x) * channels;
      const dst = (y * CROP_SIZE + x) * channels;
      for (let c = 0; c < channels; c++) {
        assert.equal(crop[dst + c], data[src + c]);
      }
    }
  });

  it('rejects crops that fall outside the buffer', () => {
    const data = seededPixels(CROP_SIZE * CROP_SIZE * 4);
    assert.throws(
      () => cropPackedPixels(data, CROP_SIZE, CROP_SIZE, 4, 1, 0),
      /does not fit/
    );
  });
});

describe('preprocessRawImageViews (pillowResize path)', () => {
  it('matches manual pillowResize + window crop + CHW on the center view', async () => {
    const raw = fakeRawImage(500, 400, 3);
    const views = await preprocessRawImageViews(raw);

    const plan = ttaViewPlan(raw.width, raw.height);
    assert.equal(views.length, plan.length);
    assert.deepEqual(views.map((v) => v.name), plan.map((s) => s.name));

    const center = plan[0];
    const resized = pillowResize(
      raw.data,
      raw.width,
      raw.height,
      raw.channels,
      center.resizedW,
      center.resizedH
    );
    const crop = cropPackedPixels(
      resized,
      center.resizedW,
      center.resizedH,
      raw.channels,
      center.sx,
      center.sy
    );
    assert.deepEqual(views[0].chw, packedRgbToCHW(crop, raw.channels));
  });

  it('keeps grayscale (1-channel) images finite via channel replication', async () => {
    const raw = fakeRawImage(420, 390, 1);
    const views = await preprocessRawImageViews(raw);
    for (const view of views) {
      assert.equal(view.chw.length, 3 * CROP_SIZE * CROP_SIZE);
      for (let i = 0; i < view.chw.length; i += 4111) {
        assert.ok(Number.isFinite(view.chw[i]));
      }
    }
  });

  it('center-only path agrees with the first TTA view', async () => {
    const raw = fakeRawImage(500, 400, 4);
    const [firstView] = await preprocessRawImageViews(raw);
    const centerOnly = await preprocessRawImage(raw);
    assert.deepEqual(centerOnly, firstView.chw);
  });
});

describe('decoded pixel cap (browser path)', () => {
  it('routes bitmaps above MAX_IMAGE_PIXELS to the canvas fallback', async () => {
    const huge = { width: 10000, height: 8000 };
    assert.ok(huge.width * huge.height > MAX_IMAGE_PIXELS);
    assert.equal(needsCanvasFallback(huge.width, huge.height), true);
    // The fallback itself is canvas-backed and browser-only; under Node the
    // attempt to construct the small target canvas is the observable proof
    // that the oversized bitmap took the fallback branch instead of the
    // native-size getImageData (which would be a different, huge canvas).
    await assert.rejects(() => preprocessBitmap(huge), /OffscreenCanvas/);
    await assert.rejects(() => preprocessBitmapViews(huge), /OffscreenCanvas/);
  });
});
