/**
 * DINOv2-small feature backbone + logistic probe head.
 *
 * The probe is a transparent linear head over frozen DINOv2 features:
 * standardize(CLS + mean-of-patch-tokens) -> w.x + b -> sigmoid. The
 * full parameterization ships in models/probe/dino-probe.json; there is
 * no lookup table and no per-image special casing anywhere.
 *
 * Preprocess (matches Xenova/dinov2-small preprocessor_config.json):
 * shortest edge 256, center crop 224, ImageNet mean/std.
 */

import { pillowResize } from './pixel-resize.js';
import { cropPackedPixels, needsCanvasFallback } from './clip-preprocess.js';

export const DINO_MODEL_ID = 'Xenova/dinov2-small';
export const DINO_ONNX_PATH = 'onnx/model.onnx';
export const DINO_SHORTEST_EDGE = 256;
export const DINO_CROP_SIZE = 224;
export const DINO_MEAN = [0.485, 0.456, 0.406];
export const DINO_STD = [0.229, 0.224, 0.225];
export const DINO_INPUT_NAME = 'pixel_values';
export const DINO_OUTPUT_NAME = 'last_hidden_state';

/**
 * @param {number} width
 * @param {number} height
 */
export function dinoResizeDimensions(width, height) {
  if (width <= 0 || height <= 0) {
    throw new Error('Invalid image dimensions');
  }
  if (width < height) {
    return {
      width: DINO_SHORTEST_EDGE,
      height: Math.round((height * DINO_SHORTEST_EDGE) / width),
    };
  }
  return {
    width: Math.round((width * DINO_SHORTEST_EDGE) / height),
    height: DINO_SHORTEST_EDGE,
  };
}

/**
 * @param {Uint8Array|Uint8ClampedArray|ArrayLike<number>} data packed RGB or RGBA
 * @param {number} channels
 * @returns {Float32Array} CHW, ImageNet-normalized
 */
export function dinoPackedRgbToCHW(data, channels) {
  const plane = DINO_CROP_SIZE * DINO_CROP_SIZE;
  const out = new Float32Array(3 * plane);
  // Grayscale sources have channels < 3; replicate the single channel
  // instead of reading past the pixel (which yields NaN).
  const gOff = channels >= 3 ? 1 : 0;
  const bOff = channels >= 3 ? 2 : 0;
  for (let i = 0; i < plane; i++) {
    const base = i * channels;
    out[i] = (data[base] / 255 - DINO_MEAN[0]) / DINO_STD[0];
    out[i + plane] = (data[base + gOff] / 255 - DINO_MEAN[1]) / DINO_STD[1];
    out[i + 2 * plane] = (data[base + bOff] / 255 - DINO_MEAN[2]) / DINO_STD[2];
  }
  return out;
}

/**
 * Node eval path. Shares the Pillow-exact resize with the browser path so
 * the extension, the harness, and probe training all compute identical
 * DINO inputs. The probe head shipped with this revision is trained on
 * features extracted through this exact path.
 * @param {import('@huggingface/transformers').RawImage} rawImage
 * @returns {Promise<Float32Array>}
 */
export async function dinoPreprocessRawImage(rawImage) {
  const { width: resizedW, height: resizedH } = dinoResizeDimensions(
    rawImage.width,
    rawImage.height
  );
  const resized = pillowResize(
    rawImage.data,
    rawImage.width,
    rawImage.height,
    rawImage.channels,
    resizedW,
    resizedH
  );
  const sx = Math.floor((resizedW - DINO_CROP_SIZE) / 2);
  const sy = Math.floor((resizedH - DINO_CROP_SIZE) / 2);
  const crop = cropPackedPixels(
    resized,
    resizedW,
    resizedH,
    rawImage.channels,
    sx,
    sy,
    DINO_CROP_SIZE
  );
  return dinoPackedRgbToCHW(crop, rawImage.channels);
}

/**
 * Browser path: center 224 crop from an ImageBitmap through the same
 * Pillow-exact resize as the Node path. Oversized bitmaps fall back to
 * the legacy canvas resize (same guard as the CF path).
 * @param {ImageBitmap} bitmap
 * @returns {Float32Array}
 */
export function dinoPreprocessBitmap(bitmap) {
  const { width: rw, height: rh } = dinoResizeDimensions(bitmap.width, bitmap.height);
  const sx = Math.floor((rw - DINO_CROP_SIZE) / 2);
  const sy = Math.floor((rh - DINO_CROP_SIZE) / 2);

  if (needsCanvasFallback(bitmap.width, bitmap.height)) {
    const resizeCanvas = new OffscreenCanvas(rw, rh);
    const resizeCtx = resizeCanvas.getContext('2d', { willReadFrequently: true });
    resizeCtx.imageSmoothingEnabled = true;
    resizeCtx.imageSmoothingQuality = 'high';
    resizeCtx.drawImage(bitmap, 0, 0, rw, rh);
    const imageData = resizeCtx.getImageData(0, 0, rw, rh);
    const crop = cropPackedPixels(imageData.data, rw, rh, 4, sx, sy, DINO_CROP_SIZE);
    return dinoPackedRgbToCHW(crop, 4);
  }

  const nativeCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const nativeCtx = nativeCanvas.getContext('2d', { willReadFrequently: true });
  nativeCtx.drawImage(bitmap, 0, 0);
  const rgba = nativeCtx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const resized = pillowResize(rgba, bitmap.width, bitmap.height, 4, rw, rh);
  const crop = cropPackedPixels(resized, rw, rh, 4, sx, sy, DINO_CROP_SIZE);
  return dinoPackedRgbToCHW(crop, 4);
}

/**
 * CLS + mean(patch tokens) from last_hidden_state [1, T, H].
 * @param {Float32Array|ArrayLike<number>} hidden
 * @param {number} tokens
 * @param {number} hiddenSize
 * @returns {Float32Array} length 2*hiddenSize
 */
export function dinoPoolFeatures(hidden, tokens, hiddenSize) {
  const out = new Float32Array(2 * hiddenSize);
  for (let h = 0; h < hiddenSize; h++) out[h] = hidden[h];
  for (let t = 1; t < tokens; t++) {
    const base = t * hiddenSize;
    for (let h = 0; h < hiddenSize; h++) out[hiddenSize + h] += hidden[base + h];
  }
  const n = Math.max(1, tokens - 1);
  for (let h = 0; h < hiddenSize; h++) out[hiddenSize + h] /= n;
  return out;
}

/**
 * @typedef {object} DinoProbe
 * @property {number} dims
 * @property {number[]} featureMean
 * @property {number[]} featureStd
 * @property {number[]} weights
 * @property {number} bias
 */

/**
 * @param {Float32Array|number[]} features pooled features (2*hiddenSize)
 * @param {DinoProbe} probe
 * @returns {number} p(AI) in [0, 1]
 */
export function dinoProbeScore(features, probe) {
  const dims = probe.dims;
  if (features.length !== dims) {
    throw new Error(`Probe expects ${dims} dims, got ${features.length}`);
  }
  let z = probe.bias;
  for (let d = 0; d < dims; d++) {
    z += probe.weights[d] * ((features[d] - probe.featureMean[d]) / probe.featureStd[d]);
  }
  return 1 / (1 + Math.exp(-z));
}

/**
 * Score a session output tensor with the probe. Runtime-agnostic: both
 * onnxruntime-web (extension) and onnxruntime-node (eval) tensors have
 * dims + data.
 * @param {{ dims: number[], data: Float32Array|ArrayLike<number> }} hidden last_hidden_state
 * @param {DinoProbe} probe
 */
export function dinoScoreHiddenState(hidden, probe) {
  const [, tokens, hiddenSize] = hidden.dims;
  const features = dinoPoolFeatures(hidden.data, tokens, hiddenSize);
  return dinoProbeScore(features, probe);
}
