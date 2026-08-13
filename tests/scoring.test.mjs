import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  neuralPAiFromSourceDetector,
  neuralPAiFromBinary,
  ensembleNeuralPAi,
  parseSourceDetectorOutputs,
  legacyOneMinusReal,
} from '../src/scoring.js';
import { DEFAULT_THRESHOLD } from '../src/fuse.js';

describe('neuralPAiFromSourceDetector', () => {
  it('uses max AI head, not 1-p_real, when mass spreads across AI classes', () => {
    const outputs = [
      { label: 'dalle', score: 0.355 },
      { label: 'real', score: 0.197 },
      { label: 'midjourney', score: 0.176 },
      { label: 'stable_diffusion', score: 0.157 },
      { label: 'other_ai', score: 0.115 },
    ];

    const parsed = parseSourceDetectorOutputs(outputs);
    assert.ok(parsed.oneMinusReal > 0.8);
    assert.ok(parsed.maxAi < 0.4);

    const pAi = neuralPAiFromSourceDetector(outputs);
    assert.equal(pAi, parsed.maxAi);
    assert.ok(pAi < DEFAULT_THRESHOLD);
  });

  it('uses the winning AI class score when argmax is AI', () => {
    const outputs = [
      { label: 'stable_diffusion', score: 0.72 },
      { label: 'real', score: 0.12 },
      { label: 'midjourney', score: 0.08 },
      { label: 'dalle', score: 0.05 },
      { label: 'other_ai', score: 0.03 },
    ];

    const pAi = neuralPAiFromSourceDetector(outputs);
    assert.equal(pAi, 0.72);
    assert.ok(pAi >= DEFAULT_THRESHOLD);
  });

  it('keeps a high p(real) photograph below threshold when only AI tails remain', () => {
    const outputs = [
      { label: 'real', score: 0.62 },
      { label: 'stable_diffusion', score: 0.14 },
      { label: 'midjourney', score: 0.11 },
      { label: 'dalle', score: 0.08 },
      { label: 'other_ai', score: 0.05 },
    ];

    const pAi = neuralPAiFromSourceDetector(outputs);
    assert.equal(pAi, 0.14);
    assert.ok(pAi < DEFAULT_THRESHOLD);
  });

  it('lifts borderline AI argmax scores using secondary AI mass', () => {
    const outputs = [
      { label: 'stable_diffusion', score: 0.58 },
      { label: 'midjourney', score: 0.14 },
      { label: 'dalle', score: 0.12 },
      { label: 'other_ai', score: 0.1 },
      { label: 'real', score: 0.06 },
    ];

    const pAi = neuralPAiFromSourceDetector(outputs);
    assert.ok(pAi > 0.58);
    assert.ok(pAi >= DEFAULT_THRESHOLD);
  });
});

describe('legacyOneMinusReal', () => {
  it('documents the inflated legacy mapping for spread mass', () => {
    const outputs = [
      { label: 'midjourney', score: 0.446 },
      { label: 'real', score: 0.173 },
      { label: 'stable_diffusion', score: 0.161 },
      { label: 'other_ai', score: 0.154 },
      { label: 'dalle', score: 0.066 },
    ];

    assert.ok(legacyOneMinusReal(outputs) > 0.8);
    assert.ok(neuralPAiFromSourceDetector(outputs) < DEFAULT_THRESHOLD);
  });
});

describe('ensembleNeuralPAi', () => {
  it('defaults to source-detector top AI head mapping', () => {
    const outputs = [
      { label: 'real', score: 0.62 },
      { label: 'stable_diffusion', score: 0.14 },
      { label: 'midjourney', score: 0.11 },
      { label: 'dalle', score: 0.08 },
      { label: 'other_ai', score: 0.05 },
    ];
    const binary = [
      { label: 'Fake', score: 0.99 },
      { label: 'Real', score: 0.01 },
    ];

    assert.equal(ensembleNeuralPAi(outputs, binary), neuralPAiFromSourceDetector(outputs));
  });
});

describe('neuralPAiFromBinary', () => {
  it('returns Fake probability', () => {
    const outputs = [
      { label: 'Fake', score: 0.91 },
      { label: 'Real', score: 0.09 },
    ];
    assert.equal(neuralPAiFromBinary(outputs), 0.91);
  });
});
