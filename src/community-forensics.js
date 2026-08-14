import * as ort from 'onnxruntime-web';
import {
  CROP_SIZE,
  MODEL_ID,
  MODEL_ONNX_PATH,
  ONNX_INPUT_NAME,
  ONNX_OUTPUT_NAME,
} from './models.js';
import {
  neuralPAiFromLogit,
  aggregateViewScores,
  shouldRunExtraCrops,
  TTA_EARLY_EXIT,
} from './scoring.js';

const REQUIRED_WASM_FILES = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'];

/** ORT session option: OrtLoggingLevel::ORT_LOGGING_LEVEL_ERROR (suppresses W: lines). */
export const ORT_SESSION_LOG_OPTIONS = { logSeverityLevel: 3 };

/**
 * ONNX Runtime logs routine WebGPU/WASM placement warnings at severity "warning".
 * Chrome lists extension console.warn on chrome://extensions as Errors, so keep ORT
 * at error/fatal only. Real session failures still propagate as thrown errors.
 */
export function configureOrtLogging() {
  ort.env.logLevel = 'error';
}

/**
 * @param {GPUAdapter | null | undefined} adapter
 */
export function shouldTryWebGpu(adapter) {
  return adapter != null;
}

/**
 * @returns {Promise<GPUAdapter | null>}
 */
export async function probeWebGpuAdapter() {
  if (!globalThis.navigator?.gpu?.requestAdapter) {
    return null;
  }

  try {
    return (await navigator.gpu.requestAdapter()) ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {string} wasmPaths base URL with trailing slash
 */
export async function verifyWasmAssets(wasmPaths) {
  if (!wasmPaths) {
    throw new Error('onnxruntime WASM path is not configured');
  }

  const missing = [];

  for (const file of REQUIRED_WASM_FILES) {
    const url = `${wasmPaths}${file}`;
    if (!(await assetReachable(url))) {
      missing.push(file);
    }
  }

  if (missing.length) {
    throw new Error(
      `Missing onnxruntime WASM files in lib/: ${missing.join(', ')}. Rebuild the extension.`
    );
  }
}

/**
 * HEAD with GET/Range fallback for extension asset URLs.
 * @param {string} url
 */
export async function assetReachable(url) {
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (head.ok) return true;
  } catch {
    // HEAD may be blocked in extension contexts.
  }

  try {
    const ranged = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    if (ranged.ok || ranged.status === 206) return true;
  } catch {
    // fall through
  }

  try {
    const get = await fetch(url, { method: 'GET', cache: 'no-store' });
    return get.ok;
  } catch {
    return false;
  }
}

/**
 * @param {ort.InferenceSession} session
 * @param {Float32Array} chw length 3*384*384
 */
export async function predictCHW(session, chw) {
  const input = new ort.Tensor('float32', chw, [1, 3, CROP_SIZE, CROP_SIZE]);
  const outputs = await session.run({ [ONNX_INPUT_NAME]: input });
  const logit = outputs[ONNX_OUTPUT_NAME].data[0];
  return neuralPAiFromLogit(logit);
}

/**
 * Score every view and take max sigmoid. Used by the harness `--tta=always` probe.
 * @param {ort.InferenceSession} session
 * @param {Array<{name: string, chw: Float32Array}>} views
 */
export async function predictViews(session, views) {
  const scores = [];
  for (const view of views) {
    scores.push(await predictCHW(session, view.chw));
  }
  return {
    scores,
    named: views.map((view, i) => ({ name: view.name, score: scores[i] })),
    neuralPAi: aggregateViewScores(scores),
    extraRan: views.length > 1,
    earlyExit: false,
  };
}

/**
 * Production TTA: official 440 center first. Extra crops (440 corners + 512
 * center) run only in the adaptive band, or when mode is `always`. Stops if
 * any sigmoid is >= 0.9. Does not stretch scores.
 *
 * @param {ort.InferenceSession} session
 * @param {Array<{name: string, chw: Float32Array}>} views
 * @param {{ mode?: 'adaptive' | 'always' | 'center', earlyExit?: number }} [options]
 */
export async function predictAdaptiveViews(session, views, options = {}) {
  const mode = options.mode || 'adaptive';
  const earlyExit = options.earlyExit ?? TTA_EARLY_EXIT;

  if (!views?.length) {
    return {
      scores: [],
      named: [],
      neuralPAi: 0.5,
      extraRan: false,
      earlyExit: false,
    };
  }

  const scores = [];
  const named = [];

  const centerScore = await predictCHW(session, views[0].chw);
  scores.push(centerScore);
  named.push({ name: views[0].name, score: centerScore });

  if (centerScore >= earlyExit) {
    return { scores, named, neuralPAi: centerScore, extraRan: false, earlyExit: true };
  }

  const runExtra =
    mode === 'always' || (mode === 'adaptive' && shouldRunExtraCrops(centerScore));

  if (!runExtra) {
    return { scores, named, neuralPAi: centerScore, extraRan: false, earlyExit: false };
  }

  let max = centerScore;
  for (let i = 1; i < views.length; i++) {
    const score = await predictCHW(session, views[i].chw);
    scores.push(score);
    named.push({ name: views[i].name, score });
    if (score > max) max = score;
    if (score >= earlyExit) {
      return { scores, named, neuralPAi: max, extraRan: true, earlyExit: true };
    }
  }

  return { scores, named, neuralPAi: max, extraRan: true, earlyExit: false };
}

/**
 * @param {{
 *   modelUrl: string,
 *   wasmPaths: string,
 *   preferWebGpu?: boolean,
 *   verifyWasmAssets?: boolean,
 * }} options
 * @returns {Promise<{ session: ort.InferenceSession, device: 'webgpu' | 'wasm' }>}
 */
export async function createCommunityForensicsSession(options) {
  configureOrtLogging();
  ort.env.wasm.wasmPaths = options.wasmPaths;
  ort.env.wasm.numThreads = options.numThreads ?? 1;

  if (options.verifyWasmAssets !== false) {
    await verifyWasmAssets(options.wasmPaths);
  }

  if (options.preferWebGpu) {
    try {
      const session = await ort.InferenceSession.create(options.modelUrl, {
        executionProviders: ['webgpu'],
        ...ORT_SESSION_LOG_OPTIONS,
      });
      return { session, device: 'webgpu' };
    } catch (err) {
      console.warn('WebGPU session failed, retrying with WASM only:', err?.message || err);
    }
  }

  // Linux VMs and some Windows/Mac GPUs have no adapter. WASM is required.

  const session = await ort.InferenceSession.create(options.modelUrl, {
    executionProviders: ['wasm'],
    ...ORT_SESSION_LOG_OPTIONS,
  });
  return { session, device: 'wasm' };
}

export { MODEL_ID, MODEL_ONNX_PATH };
