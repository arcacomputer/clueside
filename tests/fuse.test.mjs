import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fuseScores,
  isAiAtThreshold,
  DEFAULT_THRESHOLD,
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
    const result = fuseScores(0.4, {
      ...emptySignals,
      urlHint: true,
      urlHintReason: 'URL suggests Midjourney CDN',
      reasons: ['URL suggests Midjourney CDN'],
    });

    assert.equal(result.rawScore, 0.4 + URL_HINT_MAX_BOOST);
    assert.ok(result.rawScore < DEFAULT_THRESHOLD);
    assert.equal(result.verdict, 'uncertain');
    assert.equal(isAiAtThreshold(result.rawScore, DEFAULT_THRESHOLD), false);
  });
});
