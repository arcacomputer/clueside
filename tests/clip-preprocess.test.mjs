import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cropOrigins,
  resizeDimensions,
  ttaViewPlan,
} from '../src/clip-preprocess.js';
import { CROP_SIZE, SHORTEST_EDGE, TTA_EXTRA_SHORTEST_EDGE } from '../src/models.js';

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
