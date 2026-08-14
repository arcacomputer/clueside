import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveTtaMode, fuseInferenceScores } from '../src/inference-policy.js';

const noSignals = {
  c2paAi: false,
  c2paReason: null,
  metadataAi: false,
  metadataReason: null,
  urlHint: false,
  urlHintReason: null,
  freqResidualVote: 0,
  reasons: [],
};

describe('production inference policy', () => {
  it('expands adaptive TTA only when DINO is suspicious', () => {
    assert.equal(effectiveTtaMode('adaptive', 0.149), 'adaptive');
    assert.equal(effectiveTtaMode('adaptive', 0.15), 'always');
    assert.equal(effectiveTtaMode('center', 0.99), 'center');
    assert.equal(effectiveTtaMode('always', null), 'always');
  });

  it('applies CF-primary neural fusion before deterministic metadata', () => {
    assert.equal(fuseInferenceScores(0.149, 0.99, noSignals).rawScore, 0.149);
    assert.equal(fuseInferenceScores(0.5, 0.8, noSignals).rawScore, 0.8);

    const forced = fuseInferenceScores(0.1, 0.1, {
      ...noSignals,
      metadataAi: true,
      metadataReason: 'AI generator metadata: ComfyUI',
    });
    assert.equal(forced.rawScore, 0.97);
    assert.equal(forced.forcedByMetadata, true);
  });
});
