import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldTryWebGpu } from '../src/community-forensics.js';

describe('shouldTryWebGpu', () => {
  it('returns false when adapter is null', () => {
    assert.equal(shouldTryWebGpu(null), false);
  });

  it('returns false when adapter is undefined', () => {
    assert.equal(shouldTryWebGpu(undefined), false);
  });

  it('returns true when adapter is present', () => {
    assert.equal(shouldTryWebGpu({}), true);
  });
});
