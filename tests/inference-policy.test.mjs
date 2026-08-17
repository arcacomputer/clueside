import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveTtaMode, fuseInferenceScores } from '../src/inference-policy.js';
import { fuseNeuralScores, DEFAULT_THRESHOLD } from '../src/fuse.js';

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
    assert.equal(fuseInferenceScores(0.004, 0.99, noSignals).rawScore, 0.004);
    assert.equal(fuseInferenceScores(0.5, 0.8, noSignals).rawScore, 0.8);

    const forced = fuseInferenceScores(0.1, 0.1, {
      ...noSignals,
      metadataAi: true,
      metadataReason: 'AI generator metadata: ComfyUI',
    });
    assert.equal(forced.rawScore, 0.97);
    assert.equal(forced.forcedByMetadata, true);
  });

  it('suppresses DINO lift on flat graphics when CF stays below threshold', () => {
    assert.equal(
      fuseNeuralScores(0.45, 0.99, { graphicGate: true }),
      0.45
    );
    assert.equal(fuseInferenceScores(0.45, 0.99, noSignals, DEFAULT_THRESHOLD, {
      graphicGate: true,
    }).rawScore, 0.45);
  });

  it('requires a high-confidence DINO rescue before lifting a low CF score', () => {
    assert.equal(fuseInferenceScores(0.45, 0.66, noSignals).rawScore, 0.45);
    assert.equal(fuseInferenceScores(0.45, 0.72, noSignals).rawScore, 0.72);
  });

  it('blocks a middling DINO lift after CF agreement falls back', () => {
    assert.equal(
      fuseNeuralScores(0.4, 0.76, { agreementFallback: true }),
      0.4
    );
    assert.equal(
      fuseNeuralScores(0.4, 0.97, { agreementFallback: true }),
      0.97
    );
  });

  it('does not suppress CF-confident AI illustrations on flat graphics', () => {
    assert.equal(fuseNeuralScores(0.72, 0.12, { graphicGate: true }), 0.72);
    assert.equal(
      fuseInferenceScores(0.72, 0.12, noSignals, DEFAULT_THRESHOLD, {
        graphicGate: true,
      }).verdict,
      'ai'
    );
  });
});
