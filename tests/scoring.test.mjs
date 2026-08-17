import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sigmoid,
  neuralPAiFromLogit,
  logitAtProbability,
  aggregateViewScores,
  shouldRunExtraCrops,
  foldTtaScores,
  TTA_ADAPTIVE_LOW,
  TTA_EARLY_EXIT,
} from '../src/scoring.js';
import { DEFAULT_THRESHOLD } from '../src/fuse.js';

describe('sigmoid scoring', () => {
  it('sigmoid(0) is 0.5', () => {
    assert.equal(sigmoid(0), 0.5);
  });

  it('maps a logit to approximately 0.65 at the default threshold', () => {
    const logit = logitAtProbability(DEFAULT_THRESHOLD);
    const pAi = neuralPAiFromLogit(logit);
    assert.ok(Math.abs(pAi - DEFAULT_THRESHOLD) < 1e-6);
  });
});

describe('aggregateViewScores', () => {
  it('returns max of sigmoid scores, not a stretch', () => {
    assert.equal(aggregateViewScores([0.04, 0.2, 0.11]), 0.2);
  });

  it('returns 0.5 for an empty list', () => {
    assert.equal(aggregateViewScores([]), 0.5);
    assert.equal(aggregateViewScores(undefined), 0.5);
  });
});

describe('adaptive TTA fusion', () => {
  it('skips extras when center is a confident real (0.04)', () => {
    assert.equal(shouldRunExtraCrops(0.04), false);
    const folded = foldTtaScores([0.04, 0.8, 0.9], { mode: 'adaptive' });
    assert.equal(folded.neuralPAi, 0.04);
    assert.equal(folded.extraRan, false);
    assert.deepEqual(folded.used, [0.04]);
  });

  it('runs extras in the uncertain band including crying-robot ~0.20', () => {
    assert.equal(shouldRunExtraCrops(0.2), true);
    // A lone 0.72 among low views falls back to the runner-up; a second
    // agreeing view restores the max.
    const lone = foldTtaScores([0.2, 0.41, 0.72], { mode: 'adaptive' });
    assert.equal(lone.neuralPAi, 0.41);
    assert.equal(lone.extraRan, true);
    const agreed = foldTtaScores([0.2, 0.66, 0.72], { mode: 'adaptive' });
    assert.equal(agreed.neuralPAi, 0.72);
  });

  it('includes the low band edge 0.15 through the mid band, excludes 0.95', () => {
    assert.equal(shouldRunExtraCrops(TTA_ADAPTIVE_LOW), true);
    assert.equal(shouldRunExtraCrops(DEFAULT_THRESHOLD), true);
    assert.equal(shouldRunExtraCrops(0.84), true);
    assert.equal(shouldRunExtraCrops(0.94), true);
    assert.equal(shouldRunExtraCrops(TTA_EARLY_EXIT), false);
    assert.equal(shouldRunExtraCrops(0.149), false);
  });

  it('a lone mid-band view does not carry an AI verdict', () => {
    // One view at 0.70 with every other view low falls back to the
    // runner-up: live CDN-processed real photos spike single crops.
    const always = foldTtaScores([0.04, 0.7], { mode: 'always' });
    const adaptive = foldTtaScores([0.04, 0.7], { mode: 'adaptive' });
    assert.equal(always.neuralPAi, 0.04);
    assert.equal(adaptive.neuralPAi, 0.04);
  });

  it('two agreeing mid-band views keep the max', () => {
    const folded = foldTtaScores([0.3, 0.7, 0.68], { mode: 'always' });
    assert.equal(folded.neuralPAi, 0.7);
  });

  it('a lone 0.86 view no longer early-exits; agreement falls back', () => {
    // Live Unsplash editorial photos land in 0.81-0.94. A single crop
    // there is the CDN-spike pattern, not enough for an AI verdict.
    const folded = foldTtaScores([0.3, 0.86], { mode: 'always' });
    assert.equal(folded.neuralPAi, 0.3);
    assert.equal(folded.earlyExit, false);
  });

  it('a single view at or above 0.95 keeps full authority', () => {
    const folded = foldTtaScores([0.3, 0.96], { mode: 'always' });
    assert.equal(folded.neuralPAi, 0.96);
    assert.equal(folded.earlyExit, true);
  });

  it('center mode ignores extras even in the adaptive band', () => {
    const folded = foldTtaScores([0.4, 0.9], { mode: 'center' });
    assert.equal(folded.neuralPAi, 0.4);
    assert.equal(folded.extraRan, false);
  });

  it('early-exits at 0.95 without stretching remaining scores', () => {
    const folded = foldTtaScores([0.4, TTA_EARLY_EXIT, 0.99], { mode: 'adaptive' });
    assert.equal(folded.neuralPAi, TTA_EARLY_EXIT);
    assert.equal(folded.earlyExit, true);
    assert.deepEqual(folded.used, [0.4, TTA_EARLY_EXIT]);
  });

  it('does not remap a mid-band CDN spike to 0.65', () => {
    const folded = foldTtaScores([0.81, 0.12, 0.08], { mode: 'adaptive' });
    assert.equal(folded.neuralPAi, 0.12);
    assert.equal(folded.agreementFallback, true);
    assert.ok(folded.neuralPAi < DEFAULT_THRESHOLD);
  });

  it('does not remap 0.20 to 0.65', () => {
    const folded = foldTtaScores([0.2, 0.22, 0.18], { mode: 'adaptive' });
    assert.equal(folded.neuralPAi, 0.22);
    assert.ok(folded.neuralPAi < DEFAULT_THRESHOLD);
  });

  it('empty scores stay 0.5, not 0.65', () => {
    const folded = foldTtaScores([]);
    assert.equal(folded.neuralPAi, 0.5);
  });
});
