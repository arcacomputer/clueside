import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANALYZE_CONCURRENCY,
  TTA_SKIP_WHEN_PENDING_ABOVE,
  ttaModeForLoad,
  normalizeTtaMode,
  createAnalyzeQueue,
  createExclusiveLock,
  runExclusiveAfterStart,
} from '../src/analyze-queue.js';
import {
  FETCH_TIMEOUT_MS,
  INFERENCE_TIMEOUT_MS,
  AFTER_START_SAFETY_MS,
  isFetchSkipError,
  isTransientAnalyzeError,
  withTimeout,
} from '../src/analyze-retry.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ttaModeForLoad', () => {
  it('uses center crop when more than N images are pending', () => {
    assert.equal(ttaModeForLoad(TTA_SKIP_WHEN_PENDING_ABOVE + 1), 'center');
    assert.equal(ttaModeForLoad(40), 'center');
  });

  it('keeps adaptive TTA when the queue is short', () => {
    assert.equal(ttaModeForLoad(TTA_SKIP_WHEN_PENDING_ABOVE), 'adaptive');
    assert.equal(ttaModeForLoad(1), 'adaptive');
    assert.equal(ttaModeForLoad(2), 'adaptive');
  });

  it('normalizes unknown modes to adaptive', () => {
    assert.equal(normalizeTtaMode('center'), 'center');
    assert.equal(normalizeTtaMode('always'), 'always');
    assert.equal(normalizeTtaMode('nope'), 'adaptive');
    assert.equal(normalizeTtaMode(undefined), 'adaptive');
  });
});

describe('createAnalyzeQueue', () => {
  it('runs at most two jobs at a time', async () => {
    let current = 0;
    let max = 0;
    const started = [];

    const queue = createAnalyzeQueue({
      concurrency: ANALYZE_CONCURRENCY,
      run: async (item) => {
        current += 1;
        started.push(item);
        if (current > max) max = current;
        await sleep(20);
        current -= 1;
        return item;
      },
    });

    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => queue.enqueue(n)));
    assert.deepEqual(results, [1, 2, 3, 4, 5]);
    assert.equal(max, 2);
    assert.equal(started.length, 5);
  });

  it('passes center ttaMode while many jobs are still pending', async () => {
    const modes = [];
    const queue = createAnalyzeQueue({
      run: async (item, meta) => {
        modes.push({ item, ttaMode: meta.ttaMode, pendingCount: meta.pendingCount });
        await sleep(5);
      },
    });

    const jobCount = TTA_SKIP_WHEN_PENDING_ABOVE + 4;
    const jobs = [];
    for (let i = 0; i < jobCount; i++) jobs.push(queue.enqueue(i));
    await Promise.all(jobs);

    assert.equal(modes.length, jobCount);
    assert.equal(modes[0].pendingCount, jobCount);
    assert.equal(modes[0].ttaMode, 'center');
    assert.ok(modes[0].pendingCount > TTA_SKIP_WHEN_PENDING_ABOVE);
    const last = modes[modes.length - 1];
    assert.equal(last.ttaMode, 'adaptive');
    assert.ok(last.pendingCount <= TTA_SKIP_WHEN_PENDING_ABOVE);
  });
});

describe('runExclusiveAfterStart', () => {
  it('does not start the inference clock while waiting for the lock', async () => {
    const lock = createExclusiveLock();
    const events = [];

    const first = runExclusiveAfterStart(
      lock,
      async () => {
        events.push('first-start');
        await sleep(80);
        events.push('first-end');
        return 'a';
      },
      50,
      'Inference timed out'
    );

    await sleep(5);

    const second = runExclusiveAfterStart(
      lock,
      async () => {
        events.push('second-start');
        await sleep(10);
        events.push('second-end');
        return 'b';
      },
      50,
      'Inference timed out'
    );

    await assert.rejects(first, /Inference timed out/);
    assert.equal(await second, 'b');
    assert.ok(events.indexOf('second-start') > events.indexOf('first-end'));
  });
});

describe('fetch vs inference timeouts', () => {
  it('keeps fetch much shorter than inference', () => {
    assert.equal(FETCH_TIMEOUT_MS, 8000);
    assert.ok(INFERENCE_TIMEOUT_MS >= 45_000);
    assert.ok(AFTER_START_SAFETY_MS > INFERENCE_TIMEOUT_MS);
  });

  it('treats fetch timeout as skip, inference timeout as a hard error', () => {
    assert.equal(isFetchSkipError('Image fetch timed out'), true);
    assert.equal(isTransientAnalyzeError('Image fetch timed out'), false);
    assert.equal(isFetchSkipError('Inference timed out'), false);
    assert.equal(isTransientAnalyzeError('Inference timed out'), false);
    assert.equal(isTransientAnalyzeError('Timed out'), false);
  });

  it('withTimeout rejects with the given message', async () => {
    await assert.rejects(
      withTimeout(sleep(50), 10, 'Image fetch timed out'),
      /Image fetch timed out/
    );
  });
});
