/**
 * WebGPU wedge watchdog and one-way WASM fallback decisions.
 *
 * Live smoke of v1.3.1 (M3 Pro under GPU contention): a WebGPU session.run
 * stalled mid-page on Wikipedia and Amazon, the offscreen document failed its
 * 30 second init health check, and 104 badges stayed pending with no recovery.
 * AGENTS.md already forbids latching a WebGPU error at init ("probe the
 * adapter"), but a backend that hangs mid-run needs a runtime escape hatch.
 *
 * Everything here is pure so node:test can exercise the decision logic
 * without a browser. The offscreen document owns the actual session disposal
 * and recreation (src/offscreen.js).
 */

/**
 * A single model run (one ORT session.run call) that exceeds this is treated
 * as a wedged backend. Generous on purpose: one CommunityForensics 384 pass
 * finishes in well under 5 s on an M3 Pro even under GPU contention, and the
 * DINO 224 pass is cheaper still. Anything past 20 s means the exclusive
 * inference lock is starving the whole queue. Must stay well below
 * INFERENCE_TIMEOUT_MS (45 s, analyze-retry.js) so the wedge verdict, the
 * WASM session rebuild, and the retry of the in-flight image all fit inside
 * one inference budget.
 */
export const MODEL_RUN_WEDGE_TIMEOUT_MS = 20_000;

/** Marker prefix used to recognize watchdog timeouts in error text. */
export const MODEL_RUN_WEDGE_MESSAGE = 'Model run wedged';

function errorText(error) {
  return String(error?.message ?? error ?? '');
}

/**
 * @param {unknown} error
 * @returns {boolean} true when the error came from watchModelRun timing out
 */
export function isWedgeError(error) {
  return errorText(error).includes(MODEL_RUN_WEDGE_MESSAGE);
}

/**
 * Device-level WebGPU failures (Dawn / Chrome / onnxruntime-web wording).
 * Fetch, decode, and size-cap errors must never match: they have their own
 * skip and error paths and must not tear down a healthy backend.
 * @param {unknown} error
 */
export function isWebGpuDeviceError(error) {
  const msg = errorText(error).toLowerCase();
  if (!msg) return false;
  return (
    msg.includes('device lost') ||
    msg.includes('device is lost') ||
    msg.includes('device was lost') ||
    msg.includes('device destroyed') ||
    msg.includes('gpu device') ||
    msg.includes('gpudevice') ||
    msg.includes('gpu connection') ||
    msg.includes('gpu process') ||
    msg.includes('webgpu')
  );
}

/**
 * Decide whether an inference error must trigger the one-way WebGPU to WASM
 * fallback. Only a wedge or a device-level error on an active WebGPU backend
 * qualifies. WASM has nothing to fall back to, and a backend that already
 * fell back must not flap.
 *
 * @param {{ device: 'webgpu' | 'wasm', error: unknown, alreadyFellBack?: boolean }} input
 * @returns {boolean}
 */
export function shouldFallBackToWasm({ device, error, alreadyFellBack = false }) {
  if (alreadyFellBack) return false;
  if (device !== 'webgpu') return false;
  return isWedgeError(error) || isWebGpuDeviceError(error);
}

/**
 * One-way health latch for the lifetime of the offscreen document.
 * markUnhealthy returns true only on the first call so the caller can log
 * the fallback exactly once. There is deliberately no way to reset it:
 * WebGPU comes back only when the offscreen document restarts.
 */
export function createWebGpuHealth() {
  let unhealthy = false;
  let reason = null;

  return {
    markUnhealthy(newReason) {
      if (unhealthy) return false;
      unhealthy = true;
      reason = String(newReason || 'unknown');
      return true;
    },
    isUnhealthy() {
      return unhealthy;
    },
    reason() {
      return reason;
    },
  };
}

/**
 * Race one started model run against the wedge timeout. WebGPU has no abort:
 * the underlying promise may never settle, so on timeout the caller must stop
 * using the wedged session and dispose it instead of awaiting it again. A
 * late settle of the abandoned run is swallowed so it cannot surface as an
 * unhandled rejection.
 *
 * @param {Promise<unknown> | (() => Promise<unknown>)} work
 * @param {{ timeoutMs?: number }} [options]
 */
export function watchModelRun(work, options = {}) {
  const timeoutMs = options.timeoutMs ?? MODEL_RUN_WEDGE_TIMEOUT_MS;
  const promise =
    typeof work === 'function' ? Promise.resolve().then(work) : Promise.resolve(work);
  promise.catch(() => {});

  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${MODEL_RUN_WEDGE_MESSAGE}: run exceeded ${timeoutMs} ms`));
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Wrap an ORT session so every run is watched by the wedge timer. predictCHW,
 * predictAdaptiveViews, and the DINO head only call session.run, so a run and
 * release surface is enough.
 *
 * @param {{ run: (...args: unknown[]) => Promise<unknown>, release?: () => Promise<void> }} session
 * @param {{ timeoutMs?: number }} [options]
 */
export function wrapSessionWithWatchdog(session, options = {}) {
  return {
    run: (...args) => watchModelRun(() => session.run(...args), options),
    release: () => session.release?.(),
  };
}
