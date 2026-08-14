import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THRESHOLD } from '../src/fuse.js';
import { productCfScore, productFloorScore } from '../eval/product-policy.mjs';

describe('offline product policy mirror', () => {
  it('keeps production TTA gating fixed at raw 0.65', () => {
    const rec = { views: { center: 0.55, tl: 0.9, tr: 0.2 } };
    assert.equal(DEFAULT_THRESHOLD, 0.65);
    assert.ok(Math.abs(productCfScore(rec, null) - 0.725) < 1e-12);
  });

  it('uses the fixed production threshold for CF-primary DINO fusion', () => {
    const rec = { views: { center: 0.4, tl: 0.5 } };
    assert.equal(productCfScore(rec, 0.8), 0.45);
    assert.equal(productFloorScore(rec, 0.8, 0.15), 0.8);
  });

  it('does not let DINO replace a production CF score already at 0.65', () => {
    const rec = { views: { center: 0.65, tl: 0.2 } };
    assert.equal(productFloorScore(rec, 0.99, 0.15), 0.65);
  });
});
