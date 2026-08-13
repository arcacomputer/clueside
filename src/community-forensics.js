import * as ort from 'onnxruntime-web';
import {
  CROP_SIZE,
  MODEL_ID,
  MODEL_ONNX_PATH,
  ONNX_INPUT_NAME,
  ONNX_OUTPUT_NAME,
} from './models.js';
import { neuralPAiFromLogit } from './scoring.js';

const REQUIRED_WASM_FILES = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'];

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
 * @param {{
 *   modelUrl: string,
 *   wasmPaths: string,
 *   preferWebGpu?: boolean,
 *   verifyWasmAssets?: boolean,
 * }} options
 * @returns {Promise<{ session: ort.InferenceSession, device: 'webgpu' | 'wasm' }>}
 */
export async function createCommunityForensicsSession(options) {
  ort.env.wasm.wasmPaths = options.wasmPaths;
  ort.env.wasm.numThreads = 1;

  if (options.verifyWasmAssets !== false) {
    await verifyWasmAssets(options.wasmPaths);
  }

  if (options.preferWebGpu) {
    try {
      const session = await ort.InferenceSession.create(options.modelUrl, {
        executionProviders: ['webgpu'],
      });
      return { session, device: 'webgpu' };
    } catch (err) {
      console.warn('WebGPU session failed, retrying with WASM only:', err?.message || err);
    }
  }

  const session = await ort.InferenceSession.create(options.modelUrl, {
    executionProviders: ['wasm'],
  });
  return { session, device: 'wasm' };
}

export { MODEL_ID, MODEL_ONNX_PATH };
