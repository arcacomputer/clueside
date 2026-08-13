import * as ort from 'onnxruntime-web';
import {
  CROP_SIZE,
  MODEL_ID,
  MODEL_ONNX_PATH,
  ONNX_INPUT_NAME,
  ONNX_OUTPUT_NAME,
} from './models.js';
import { neuralPAiFromLogit } from './scoring.js';

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
 *   useWebGpu?: boolean,
 * }} options
 */
export async function createCommunityForensicsSession(options) {
  ort.env.wasm.wasmPaths = options.wasmPaths;
  ort.env.wasm.numThreads = 1;

  const providers = options.useWebGpu ? ['webgpu', 'wasm'] : ['wasm'];
  return ort.InferenceSession.create(options.modelUrl, { executionProviders: providers });
}

export { MODEL_ID, MODEL_ONNX_PATH };
