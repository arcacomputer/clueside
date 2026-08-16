import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODEL_RUN_WEDGE_TIMEOUT_MS,
  MODEL_RUN_WEDGE_MESSAGE,
  isWedgeError,
  isWebGpuDeviceError,
  shouldFallBackToWasm,
  createWebGpuHealth,
  watchModelRun,
  wrapSessionWithWatchdog,
} from '../src/webgpu-watchdog.js';
import { INFERENCE_TIMEOUT_MS } from '../src/analyze-retry.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('wedge timeout budget', () => {
  it('is generous but leaves room for the WASM rebuild and retry', () => {
    assert.equal(MODEL_RUN_WEDGE_TIMEOUT_MS, 20_000);
    assert.ok(MODEL_RUN_WEDGE_TIMEOUT_MS < INFERENCE_TIMEOUT_MS / 2);
  });
});

describe('isWedgeError', () => {
  it('recognizes watchdog timeouts by message', () => {
    assert.equal(isWedgeError(new Error(`${MODEL_RUN_WEDGE_MESSAGE}: run exceeded 20000 ms`)), true);
    assert.equal(isWedgeError(`${MODEL_RUN_WEDGE_MESSAGE}: run exceeded 20000 ms`), true);
  });

  it('does not match unrelated errors', () => {
    assert.equal(isWedgeError(new Error('Image fetch timed out')), false);
    assert.equal(isWedgeError(new Error('Inference timed out')), false);
    assert.equal(isWedgeError(null), false);
    assert.equal(isWedgeError(undefined), false);
  });
});

describe('isWebGpuDeviceError', () => {
  it('matches device-level WebGPU failures', () => {
    assert.equal(isWebGpuDeviceError(new Error('Device lost: destroyed')), true);
    assert.equal(isWebGpuDeviceError(new Error('GPUDevice is invalid')), true);
    assert.equal(isWebGpuDeviceError(new Error('WebGPU validation error')), true);
    assert.equal(isWebGpuDeviceError(new Error('The GPU process crashed')), true);
    assert.equal(isWebGpuDeviceError('gpu connection lost'), true);
  });

  it('never matches fetch, decode, or size-cap errors', () => {
    assert.equal(isWebGpuDeviceError(new Error('Image fetch failed (404)')), false);
    assert.equal(isWebGpuDeviceError(new Error('Image fetch timed out')), false);
    assert.equal(isWebGpuDeviceError(new Error('Image exceeds size cap')), false);
    assert.equal(isWebGpuDeviceError(new Error('Not an image content-type (text/html)')), false);
    assert.equal(isWebGpuDeviceError(new Error('The source image could not be decoded')), false);
    assert.equal(isWebGpuDeviceError(''), false);
    assert.equal(isWebGpuDeviceError(null), false);
  });
});

describe('shouldFallBackToWasm', () => {
  const wedge = new Error(`${MODEL_RUN_WEDGE_MESSAGE}: run exceeded 20000 ms`);

  it('falls back on a wedged WebGPU run', () => {
    assert.equal(shouldFallBackToWasm({ device: 'webgpu', error: wedge }), true);
  });

  it('falls back on a WebGPU device error', () => {
    assert.equal(
      shouldFallBackToWasm({ device: 'webgpu', error: new Error('Device lost') }),
      true
    );
  });

  it('never falls back from WASM (nothing below it)', () => {
    assert.equal(shouldFallBackToWasm({ device: 'wasm', error: wedge }), false);
    assert.equal(
      shouldFallBackToWasm({ device: 'wasm', error: new Error('Device lost') }),
      false
    );
  });

  it('is one-way: no second fallback once fallen back', () => {
    assert.equal(
      shouldFallBackToWasm({ device: 'webgpu', error: wedge, alreadyFellBack: true }),
      false
    );
  });

  it('ignores ordinary inference errors on WebGPU', () => {
    assert.equal(
      shouldFallBackToWasm({ device: 'webgpu', error: new Error('invalid dims') }),
      false
    );
    assert.equal(
      shouldFallBackToWasm({ device: 'webgpu', error: new Error('Image fetch timed out') }),
      false
    );
  });
});

describe('createWebGpuHealth', () => {
  it('latches on the first mark and reports it once', () => {
    const health = createWebGpuHealth();
    assert.equal(health.isUnhealthy(), false);
    assert.equal(health.reason(), null);

    assert.equal(health.markUnhealthy('Device lost'), true);
    assert.equal(health.isUnhealthy(), true);
    assert.equal(health.reason(), 'Device lost');

    assert.equal(health.markUnhealthy('later error'), false);
    assert.equal(health.reason(), 'Device lost');
    assert.equal(health.isUnhealthy(), true);
  });

  it('defaults an empty reason to unknown', () => {
    const health = createWebGpuHealth();
    health.markUnhealthy('');
    assert.equal(health.reason(), 'unknown');
  });
});

describe('watchModelRun', () => {
  it('passes through a run that finishes in time', async () => {
    assert.equal(await watchModelRun(async () => 'ok', { timeoutMs: 100 }), 'ok');
  });

  it('rejects a wedged run with the wedge message', async () => {
    let hungResolve;
    const hung = new Promise((resolve) => {
      hungResolve = resolve;
    });
    await assert.rejects(
      watchModelRun(() => hung, { timeoutMs: 20 }),
      new RegExp(MODEL_RUN_WEDGE_MESSAGE)
    );
    hungResolve('late');
  });

  it('propagates the run error unchanged when the run fails fast', async () => {
    await assert.rejects(
      watchModelRun(() => Promise.reject(new Error('Device lost')), { timeoutMs: 100 }),
      /Device lost/
    );
  });

  it('swallows a late rejection of the abandoned run', async () => {
    let hungReject;
    const hung = new Promise((_, reject) => {
      hungReject = reject;
    });
    await assert.rejects(watchModelRun(hung, { timeoutMs: 10 }), new RegExp(MODEL_RUN_WEDGE_MESSAGE));
    hungReject(new Error('late device loss'));
    await sleep(10);
  });
});

describe('wrapSessionWithWatchdog', () => {
  it('forwards feeds and results for healthy runs', async () => {
    const seen = [];
    const wrapped = wrapSessionWithWatchdog(
      {
        run: async (feeds) => {
          seen.push(feeds);
          return { logits: { data: [1.5] } };
        },
      },
      { timeoutMs: 100 }
    );
    const out = await wrapped.run({ input: 'tensor' });
    assert.deepEqual(seen, [{ input: 'tensor' }]);
    assert.equal(out.logits.data[0], 1.5);
  });

  it('turns a hung session.run into a wedge rejection', async () => {
    const wrapped = wrapSessionWithWatchdog(
      { run: () => new Promise(() => {}) },
      { timeoutMs: 15 }
    );
    await assert.rejects(wrapped.run({}), new RegExp(MODEL_RUN_WEDGE_MESSAGE));
  });

  it('delegates release to the underlying session', async () => {
    let released = false;
    const wrapped = wrapSessionWithWatchdog({
      run: async () => ({}),
      release: async () => {
        released = true;
      },
    });
    await wrapped.release();
    assert.equal(released, true);
  });
});

describe('offscreen wiring', () => {
  it('wraps WebGPU sessions with the watchdog and keeps the fallback one-way', async () => {
    const source = await readFile(join(ROOT, 'src/offscreen.js'), 'utf8');
    assert.match(source, /wrapSessionWithWatchdog/);
    assert.match(source, /watchGpuDeviceLoss/);
    assert.match(source, /fallbackToWasm/);
    assert.match(source, /shouldFallBackToWasm/);
    // Logged once: the console.warn lives behind the single-shot promise guard.
    assert.match(source, /if \(wasmFallbackPromise\) return wasmFallbackPromise;/);
    assert.match(source, /WebGPU backend unhealthy/);
    // One-way: nothing in the offscreen document resets the health latch.
    assert.doesNotMatch(source, /markHealthy|reset\(\)/);
  });
});
