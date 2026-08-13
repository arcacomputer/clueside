import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  hybridSourcePAi,
  legacyOneMinusReal,
  maxAiHeadOnly,
  neuralPAiFromDistilled,
  neuralPAiForStrategy,
} from '../src/scoring.js';
import { DEFAULT_THRESHOLD } from '../src/fuse.js';

describe('hybridSourcePAi', () => {
  it('uses max AI head when argmax is real', () => {
    const outputs = [
      { label: 'real', score: 0.62 },
      { label: 'stable_diffusion', score: 0.14 },
      { label: 'midjourney', score: 0.11 },
      { label: 'dalle', score: 0.08 },
      { label: 'other_ai', score: 0.05 },
    ];

    assert.equal(hybridSourcePAi(outputs), 0.14);
    assert.ok(hybridSourcePAi(outputs) < DEFAULT_THRESHOLD);
    assert.ok(legacyOneMinusReal(outputs) > hybridSourcePAi(outputs));
  });

  it('uses 1-p(real) when argmax is an AI class', () => {
    const outputs = [
      { label: 'stable_diffusion', score: 0.72 },
      { label: 'real', score: 0.12 },
      { label: 'midjourney', score: 0.08 },
      { label: 'dalle', score: 0.05 },
      { label: 'other_ai', score: 0.03 },
    ];

    assert.equal(hybridSourcePAi(outputs), 0.88);
    assert.ok(hybridSourcePAi(outputs) >= DEFAULT_THRESHOLD);
  });
});

describe('maxAiHeadOnly', () => {
  it('stays below threshold when heads are spread (PR #2 failure mode)', () => {
    const outputs = [
      { label: 'dalle', score: 0.35 },
      { label: 'real', score: 0.2 },
      { label: 'midjourney', score: 0.18 },
      { label: 'stable_diffusion', score: 0.15 },
      { label: 'other_ai', score: 0.12 },
    ];

    assert.ok(maxAiHeadOnly(outputs) < DEFAULT_THRESHOLD);
    assert.ok(legacyOneMinusReal(outputs) > DEFAULT_THRESHOLD);
  });
});

describe('neuralPAiFromDistilled', () => {
  it('returns fake probability from binary head', () => {
    const outputs = [
      { label: 'fake', score: 0.82 },
      { label: 'real', score: 0.18 },
    ];
    assert.equal(neuralPAiFromDistilled(outputs), 0.82);
  });
});

describe('neuralPAiForStrategy', () => {
  it('routes distilled strategy to binary head', () => {
    const distilled = [
      { label: 'fake', score: 0.71 },
      { label: 'real', score: 0.29 },
    ];
    const source = [
      { label: 'real', score: 0.9 },
      { label: 'stable_diffusion', score: 0.05 },
      { label: 'midjourney', score: 0.02 },
      { label: 'dalle', score: 0.02 },
      { label: 'other_ai', score: 0.01 },
    ];

    assert.equal(neuralPAiForStrategy('distilled', distilled, source), 0.71);
    assert.equal(neuralPAiForStrategy('hybrid', distilled, source), maxAiHeadOnly(source));
  });
});
