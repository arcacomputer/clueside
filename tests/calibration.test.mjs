import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calibrationMetrics } from '../eval/calibration.mjs';

describe('raw-score calibration diagnostics', () => {
  it('reports zero error for perfectly calibrated hard predictions', () => {
    const records = [
      { label: 'ai', score: 1 },
      { label: 'real', score: 0 },
    ];
    const result = calibrationMetrics(records, (record) => record.score);
    assert.equal(result.n, 2);
    assert.equal(result.brier, 0);
    assert.equal(result.ece, 0);
  });

  it('measures raw probabilities without changing them', () => {
    const records = [
      { label: 'ai', score: 0.8 },
      { label: 'real', score: 0.2 },
    ];
    const result = calibrationMetrics(records, (record) => record.score);
    assert.ok(Math.abs(result.brier - 0.04) < 1e-12);
    assert.ok(Math.abs(result.ece - 0.2) < 1e-12);
    assert.deepEqual(result.bins.map((bin) => bin.meanConfidence), [0.2, 0.8]);
  });

  it('excludes failed and unlabeled rows from honest reporting', () => {
    const records = [
      { label: 'ai', score: 0.7 },
      { label: 'real', score: 0.1, error: 'decode failed' },
      { label: null, score: 0.9 },
    ];
    assert.equal(calibrationMetrics(records, (record) => record.score).n, 1);
  });

  it('rejects an invalid bin count', () => {
    assert.throws(() => calibrationMetrics([], () => 0.5, 0), /positive integer/);
  });
});
