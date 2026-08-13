import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sigmoid,
  neuralPAiFromLogit,
  logitAtProbability,
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
