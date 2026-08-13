import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTransientAnalyzeError,
  isFetchSkipError,
  backoffMs,
  withRetries,
  withAnalyzeDeadline,
  toSkipResult,
} from '../src/analyze-retry.js';

describe('isTransientAnalyzeError', () => {
  it('treats missing buffer crashes as retryable', () => {
    assert.equal(
      isTransientAnalyzeError("Cannot read properties of undefined (reading 'buffer')"),
      true
    );
  });

  it('treats offscreen connection failures as retryable', () => {
    assert.equal(isTransientAnalyzeError('Could not establish connection. Receiving end does not exist.'), true);
    assert.equal(isTransientAnalyzeError('Offscreen listener not ready'), true);
    assert.equal(isTransientAnalyzeError('No image bytes received (missing bufferB64 and non-http URL)'), true);
  });

  it('does not retry unsupported URL scheme', () => {
    assert.equal(isTransientAnalyzeError('Unsupported URL scheme for URL analysis'), false);
  });

  it('does not retry CDN/CORS fetch failures', () => {
    assert.equal(isFetchSkipError('Failed to fetch'), true);
    assert.equal(isFetchSkipError('Image fetch failed (403)'), true);
    assert.equal(isTransientAnalyzeError('Failed to fetch'), false);
    assert.equal(isTransientAnalyzeError('Image fetch failed (403)'), false);
    assert.equal(isTransientAnalyzeError('Not an image content-type (text/html)'), false);
  });
});

describe('withRetries', () => {
  it('returns the first successful result', async () => {
    const result = await withRetries(async () => ({ rawScore: 0.2 }), { sleep: async () => {} });
    assert.equal(result.rawScore, 0.2);
  });

  it('retries a buffer error then succeeds', async () => {
    let attempt = 0;
    const result = await withRetries(
      async () => {
        attempt += 1;
        if (attempt < 3) {
          return { error: "Cannot read properties of undefined (reading 'buffer')" };
        }
        return { rawScore: 0.1, verdict: 'real' };
      },
      { sleep: async () => {} }
    );
    assert.equal(attempt, 3);
    assert.equal(result.verdict, 'real');
  });

  it('does not retry a skipped result', async () => {
    let attempt = 0;
    const result = await withRetries(
      async () => {
        attempt += 1;
        return { skipped: true, reason: 'Image too small' };
      },
      { sleep: async () => {} }
    );
    assert.equal(attempt, 1);
    assert.equal(result.skipped, true);
  });

  it('does not retry a CORS fetch error on the first attempt', async () => {
    let attempt = 0;
    const result = await withRetries(
      async () => {
        attempt += 1;
        return { error: 'Failed to fetch' };
      },
      { sleep: async () => {} }
    );
    assert.equal(attempt, 1);
    assert.equal(result.error, 'Failed to fetch');
  });
});

describe('withAnalyzeDeadline', () => {
  it('returns the run result when it finishes in time', async () => {
    const result = await withAnalyzeDeadline(async () => ({ rawScore: 0.12 }), {
      timeoutMs: 200,
    });
    assert.equal(result.rawScore, 0.12);
  });

  it('resolves pending analyze within the timeout instead of hanging', async () => {
    const result = await withAnalyzeDeadline(
      () => new Promise(() => {}),
      { timeoutMs: 30, timeoutMessage: 'Timed out' }
    );
    assert.equal(result.error, 'Timed out');
  });
});

describe('toSkipResult', () => {
  it('turns a fetch failure into a skip, not a layout change', () => {
    const result = toSkipResult('Failed to fetch');
    assert.equal(result.skipped, true);
    assert.match(result.reason, /Failed to fetch/);
  });
});

describe('backoffMs', () => {
  it('caps at 2000ms', () => {
    assert.equal(backoffMs(0), 150);
    assert.ok(backoffMs(10) <= 2000);
  });
});
