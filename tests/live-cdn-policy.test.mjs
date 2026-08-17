import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THRESHOLD } from '../src/fuse.js';
import { foldTtaScores, TTA_EARLY_EXIT } from '../src/scoring.js';
import { ttaModeForLoad } from '../src/analyze-queue.js';
import { productCfScore, productRawScore } from '../eval/product-policy.mjs';

const noHeur = { graphicGate: false };

/**
 * View vectors that match the 2026-08-16/17 live Unsplash observation:
 * ordinary editorial photos displayed AI 81-94% with raw == neural, on a
 * 26-badge masonry that used to shed TTA to center-only.
 */
const LIVE_CDN_SPIKES = [
  { name: 'forest-81', views: { center: 0.81, tl: 0.11, tr: 0.09, bl: 0.14, br: 0.08, center_512: 0.12 } },
  { name: 'boat-84', views: { center: 0.84, tl: 0.07, tr: 0.05, bl: 0.1, br: 0.06, center_512: 0.09 } },
  { name: 'clouds-90', views: { center: 0.9, tl: 0.13, tr: 0.08, bl: 0.11, br: 0.04, center_512: 0.16 } },
  { name: 'laptop-94', views: { center: 0.94, tl: 0.18, tr: 0.12, bl: 0.09, br: 0.15, center_512: 0.2 } },
];

describe('live CDN false-positive policy', () => {
  it('does not remap the 0.65 decision rule', () => {
    assert.equal(DEFAULT_THRESHOLD, 0.65);
    assert.equal(TTA_EARLY_EXIT, 0.95);
  });

  it('keeps extras available on a 26-image Unsplash masonry', () => {
    assert.equal(ttaModeForLoad(26), 'adaptive');
  });

  it('v1.3.2 center-only load-shed would have flagged every live spike', () => {
    for (const rec of LIVE_CDN_SPIKES) {
      const shed = foldTtaScores([rec.views.center], { mode: 'center' });
      assert.ok(shed.neuralPAi >= DEFAULT_THRESHOLD, rec.name);
    }
  });

  it('v1.3.2 early-exit 0.85 would have flagged the 0.90 and 0.94 spikes', () => {
    const clouds = foldTtaScores(Object.values(LIVE_CDN_SPIKES[2].views), {
      mode: 'adaptive',
      earlyExit: 0.85,
    });
    const laptop = foldTtaScores(Object.values(LIVE_CDN_SPIKES[3].views), {
      mode: 'adaptive',
      earlyExit: 0.85,
    });
    assert.equal(clouds.neuralPAi, 0.9);
    assert.equal(clouds.earlyExit, true);
    assert.equal(laptop.neuralPAi, 0.94);
    assert.equal(laptop.earlyExit, true);
  });

  it('production policy falls back on a lone 0.81-0.94 CDN spike', () => {
    for (const rec of LIVE_CDN_SPIKES) {
      const cf = productCfScore(rec, null);
      const raw = productRawScore({ ...rec, ...noHeur }, null);
      assert.ok(cf < DEFAULT_THRESHOLD, `${rec.name} cf=${cf}`);
      assert.ok(raw < DEFAULT_THRESHOLD, `${rec.name} raw=${raw}`);
      assert.equal(raw, cf);
    }
  });

  it('two agreeing high views still carry an AI verdict', () => {
    const rec = { views: { center: 0.9, tl: 0.88, tr: 0.2 }, ...noHeur };
    assert.equal(productCfScore(rec, null), 0.9);
    assert.ok(productRawScore(rec, null) >= DEFAULT_THRESHOLD);
  });

  it('a saturated single view still carries an AI verdict', () => {
    const rec = { views: { center: 0.99 }, ...noHeur };
    assert.equal(productCfScore(rec, null), 0.99);
    assert.ok(productRawScore(rec, null) >= DEFAULT_THRESHOLD);
  });

  it('does not let a middling DINO rescue re-flag a disagreed CF spike', () => {
    // livecdn-121: center 0.90, extras low, DINO 0.76. v1.3.2 early-exit
    // would have called AI on CF alone. After fallback, DINO 0.76 must
    // not paint the runner-up as 65%.
    const rec = {
      views: { center: 0.902, tl: 0.104, tr: 0.032, bl: 0.005, br: 0.194, center_512: 0.399 },
      ...noHeur,
    };
    assert.ok(productCfScore(rec, 0.76) < DEFAULT_THRESHOLD);
    assert.ok(productRawScore(rec, 0.76) < DEFAULT_THRESHOLD);
    assert.ok(productRawScore(rec, 0.97) >= DEFAULT_THRESHOLD);
  });

  it('still lets saturated DINO rescue a lone mid-band CF miss', () => {
    const rec = { views: { center: 0.247, tl: 0.788, tr: 0.096 }, ...noHeur };
    assert.ok(productCfScore(rec, 0.9997) < DEFAULT_THRESHOLD);
    assert.ok(productRawScore(rec, 0.9997) >= DEFAULT_THRESHOLD);
  });
});
