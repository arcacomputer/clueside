import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THRESHOLD } from '../src/fuse.js';
import {
  productCfScore,
  productFloorScore,
  productNeuralScore,
  productRawScore,
} from '../eval/product-policy.mjs';

describe('offline product policy mirror', () => {
  it('keeps production TTA gating fixed at raw 0.65', () => {
    const rec = { views: { center: 0.55, tl: 0.9, tr: 0.2 } };
    assert.equal(DEFAULT_THRESHOLD, 0.65);
    assert.equal(productCfScore(rec, null), 0.9);
  });

  it('uses the fixed production threshold for CF-primary DINO fusion', () => {
    const rec = { views: { center: 0.4, tl: 0.5 } };
    assert.equal(productCfScore(rec, 0.8), 0.5);
    assert.equal(productFloorScore(rec, 0.8, 0.4), 0.8);
  });

  it('does not let DINO replace a production CF score already at 0.65', () => {
    const rec = { views: { center: 0.65, tl: 0.2 } };
    assert.equal(productFloorScore(rec, 0.99, 0.4), 0.65);
  });

  it('mirrors the flat-graphic suppression when sweep records include the gate', () => {
    const rec = { views: { center: 0.45, tl: 0.55 }, graphicGate: true };
    assert.equal(productFloorScore(rec, 0.99, 0.4), 0.55);
    assert.equal(productNeuralScore(rec, 0.99), 0.55);
    assert.equal(productRawScore(rec, 0.99), 0.55);
  });

  it('mirrors deterministic metadata through the shared final fusion', () => {
    const rec = {
      views: { center: 0.05 },
      graphicGate: false,
      heur: {
        meta: true,
        metadataReason: 'AI generator metadata: ComfyUI',
        reasons: ['AI generator metadata: ComfyUI'],
      },
    };
    assert.equal(productRawScore(rec, 0.01), 0.97);
  });
});
