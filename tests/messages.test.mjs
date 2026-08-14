import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isBackgroundMessage } from '../src/messages.js';

describe('isBackgroundMessage', () => {
  it('accepts service-worker request types', () => {
    assert.equal(isBackgroundMessage({ type: 'analyze-url' }), true);
    assert.equal(isBackgroundMessage({ type: 'get-settings' }), true);
    assert.equal(isBackgroundMessage({ type: 'warmup' }), true);
  });

  it('declines messages intended for the offscreen document', () => {
    assert.equal(isBackgroundMessage({ target: 'offscreen', type: 'ping' }), false);
    assert.equal(isBackgroundMessage({ target: 'offscreen', type: 'analyze' }), false);
  });

  it('declines unknown and malformed messages instead of holding the channel open', () => {
    assert.equal(isBackgroundMessage({ type: 'unknown' }), false);
    assert.equal(isBackgroundMessage(null), false);
    assert.equal(isBackgroundMessage('warmup'), false);
  });
});
