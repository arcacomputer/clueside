import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fuseScores,
  fuseNeuralScores,
  isAiAtThreshold,
  DEFAULT_THRESHOLD,
  DINO_CF_FLOOR,
  URL_HINT_MAX_BOOST,
} from '../src/fuse.js';

const emptySignals = {
  c2paAi: false,
  c2paReason: null,
  metadataAi: false,
  metadataReason: null,
  urlHint: false,
  urlHintReason: null,
  freqResidualVote: 0,
  reasons: [],
};

const urlSignals = {
  ...emptySignals,
  urlHint: true,
  urlHintReason: 'URL suggests Midjourney CDN',
  reasons: ['URL suggests Midjourney CDN'],
};

describe('fuseNeuralScores policy', () => {
  it('CF high + DINO low still calls AI when CF alone is >= 0.65', () => {
    const fused = fuseNeuralScores(0.72, 0.12);
    assert.equal(fused, 0.72);
    assert.equal(isAiAtThreshold(fused), true);
  });

  it('CF near zero + DINO near one does not become AI 100%', () => {
    const fused = fuseNeuralScores(0.03, 0.99);
    assert.equal(fused, 0.03);
    assert.equal(isAiAtThreshold(fused), false);
  });

  it('CF in uncertain band can be lifted by DINO', () => {
    const fused = fuseNeuralScores(0.52, 0.88);
    assert.equal(fused, 0.88);
    assert.equal(isAiAtThreshold(fused), true);
  });

  it('CF below DINO floor ignores DINO even when high', () => {
    assert.equal(DINO_CF_FLOOR, 0.40);
    const fused = fuseNeuralScores(0.399, 0.99);
    assert.equal(fused, 0.399);
    assert.equal(isAiAtThreshold(fused), false);
  });

  it('includes the DINO floor boundary in the lift band', () => {
    assert.equal(fuseNeuralScores(DINO_CF_FLOOR, 0.91), 0.91);
  });

  it('graphic gate suppresses DINO lift in the uncertain band', () => {
    const fused = fuseNeuralScores(0.52, 0.88, { graphicGate: true });
    assert.equal(fused, 0.52);
    assert.equal(isAiAtThreshold(fused), false);
  });

  it('graphic gate does not hide CF-confident AI illustrations', () => {
    const fused = fuseNeuralScores(0.72, 0.12, { graphicGate: true });
    assert.equal(fused, 0.72);
    assert.equal(isAiAtThreshold(fused), true);
  });
});

describe('fuseScores', () => {
  it('C2PA forces AI verdict', () => {
    const result = fuseScores(0.1, {
      ...emptySignals,
      c2paAi: true,
      c2paReason: 'C2PA digitalSourceType: trained algorithmic media',
      reasons: ['C2PA digitalSourceType: trained algorithmic media'],
    });

    assert.equal(result.verdict, 'ai');
    assert.ok(result.rawScore >= 0.95);
    assert.equal(result.forcedByMetadata, true);
    assert.ok(isAiAtThreshold(result.rawScore));
  });

  it('raw 0.50 is NOT AI at 65% threshold', () => {
    const result = fuseScores(0.5, emptySignals);
    assert.equal(result.rawScore, 0.5);
    assert.equal(result.verdict, 'uncertain');
    assert.equal(isAiAtThreshold(result.rawScore, DEFAULT_THRESHOLD), false);
  });

  it('raw 0.65 is AI at threshold', () => {
    const result = fuseScores(0.65, emptySignals);
    assert.equal(result.rawScore, 0.65);
    assert.equal(result.verdict, 'ai');
    assert.equal(isAiAtThreshold(result.rawScore, DEFAULT_THRESHOLD), true);
  });

  it('URL hint alone does not flip 0.40 to AI', () => {
    const result = fuseScores(0.4, urlSignals);

    assert.equal(result.rawScore, 0.4 + URL_HINT_MAX_BOOST);
    assert.ok(result.rawScore < DEFAULT_THRESHOLD);
    assert.equal(result.verdict, 'uncertain');
    assert.equal(isAiAtThreshold(result.rawScore, DEFAULT_THRESHOLD), false);
  });

  it('URL hint does not flip 0.61 to AI at 65% threshold', () => {
    const result = fuseScores(0.61, urlSignals);

    assert.ok(result.rawScore < DEFAULT_THRESHOLD);
    assert.equal(result.verdict, 'uncertain');
    assert.equal(isAiAtThreshold(result.rawScore, DEFAULT_THRESHOLD), false);
    assert.ok(result.rawScore > 0.61);
  });
});
