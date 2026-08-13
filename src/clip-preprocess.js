import {
  CLIP_MEAN,
  CLIP_STD,
  CROP_SIZE,
  SHORTEST_EDGE,
  TTA_EXTRA_SHORTEST_EDGE,
} from './models.js';

/**
 * @param {number} width
 * @param {number} height
 */
export function resizeDimensions(width, height, shortestEdge = SHORTEST_EDGE) {
  if (width <= 0 || height <= 0) {
    throw new Error('Invalid image dimensions');
  }

  if (width < height) {
    return {
      width: shortestEdge,
      height: Math.round((height * shortestEdge) / width),
    };
  }

  return {
    width: Math.round((width * shortestEdge) / height),
    height: shortestEdge,
  };
}

/**
 * 384-crop origins on a resized canvas: center, then four corners.
 * Duplicate corners (already-square 384) are skipped.
 * @param {number} width
 * @param {number} height
 * @returns {Array<{name: string, sx: number, sy: number}>}
 */
export function cropOrigins(width, height, cropSize = CROP_SIZE) {
  if (width < cropSize || height < cropSize) {
    throw new Error(`Resized image ${width}x${height} is smaller than crop ${cropSize}`);
  }

  const cx = Math.floor((width - cropSize) / 2);
  const cy = Math.floor((height - cropSize) / 2);
  const maxX = width - cropSize;
  const maxY = height - cropSize;

  const origins = [{ name: 'center', sx: cx, sy: cy }];
  const corners = [
    { name: 'tl', sx: 0, sy: 0 },
    { name: 'tr', sx: maxX, sy: 0 },
    { name: 'bl', sx: 0, sy: maxY },
    { name: 'br', sx: maxX, sy: maxY },
  ];

  for (const corner of corners) {
    if (corner.sx !== cx || corner.sy !== cy) {
      origins.push(corner);
    }
  }

  return origins;
}

/**
 * Official 440 center+corners, then optional 512 center. Never resizes an
 * already-cropped 384 square (no double scale).
 * @param {number} width
 * @param {number} height
 * @returns {Array<{name: string, shortestEdge: number, sx: number, sy: number, resizedW: number, resizedH: number}>}
 */
export function ttaViewPlan(width, height) {
  const views = [];

  const se440 = resizeDimensions(width, height, SHORTEST_EDGE);
  for (const origin of cropOrigins(se440.width, se440.height)) {
    views.push({
      name: origin.name,
      shortestEdge: SHORTEST_EDGE,
      sx: origin.sx,
      sy: origin.sy,
      resizedW: se440.width,
      resizedH: se440.height,
    });
  }

  const se512 = resizeDimensions(width, height, TTA_EXTRA_SHORTEST_EDGE);
  const extraCenter = cropOrigins(se512.width, se512.height)[0];
  views.push({
    name: 'center_512',
    shortestEdge: TTA_EXTRA_SHORTEST_EDGE,
    sx: extraCenter.sx,
    sy: extraCenter.sy,
    resizedW: se512.width,
    resizedH: se512.height,
  });

  return views;
}

/**
 * @param {Uint8Array|ArrayLike<number>} data packed RGB or RGBA
 * @param {number} channels
 * @returns {Float32Array}
 */
export function packedRgbToCHW(data, channels) {
  const plane = CROP_SIZE * CROP_SIZE;
  const out = new Float32Array(3 * plane);

  // Grayscale sources have channels < 3; replicate the single channel
  // instead of reading past the pixel (which yields NaN).
  const gOff = channels >= 3 ? 1 : 0;
  const bOff = channels >= 3 ? 2 : 0;

  for (let i = 0; i < plane; i++) {
    const base = i * channels;
    const r = data[base] / 255;
    const g = data[base + gOff] / 255;
    const b = data[base + bOff] / 255;

    out[i] = (r - CLIP_MEAN[0]) / CLIP_STD[0];
    out[i + plane] = (g - CLIP_MEAN[1]) / CLIP_STD[1];
    out[i + 2 * plane] = (b - CLIP_MEAN[2]) / CLIP_STD[2];
  }

  return out;
}

/**
 * @param {ImageData} imageData 384x384 RGBA
 * @returns {Float32Array} CHW tensor length 3*384*384
 */
export function imageDataToCHW(imageData) {
  const { data, width, height } = imageData;
  if (width !== CROP_SIZE || height !== CROP_SIZE) {
    throw new Error(`Expected ${CROP_SIZE}x${CROP_SIZE} crop, got ${width}x${height}`);
  }
  return packedRgbToCHW(data, 4);
}

function cropCanvas(sourceCanvas, sx, sy) {
  const crop = new OffscreenCanvas(CROP_SIZE, CROP_SIZE);
  const cropCtx = crop.getContext('2d', { willReadFrequently: true });
  // 1:1 blit; smoothing settings are irrelevant here but harmless.
  cropCtx.drawImage(sourceCanvas, sx, sy, CROP_SIZE, CROP_SIZE, 0, 0, CROP_SIZE, CROP_SIZE);
  return imageDataToCHW(cropCtx.getImageData(0, 0, CROP_SIZE, CROP_SIZE));
}

function resizeBitmapCanvas(bitmap, resizedW, resizedH) {
  const resizeCanvas = new OffscreenCanvas(resizedW, resizedH);
  const resizeCtx = resizeCanvas.getContext('2d', { willReadFrequently: true });
  // The model was trained on PIL bicubic (resample=3). Chrome's default
  // imageSmoothingQuality 'low' is bilinear and visibly changes the
  // texture statistics CommunityForensics keys on; 'high' is the
  // closest canvas filter to the training-time resize.
  resizeCtx.imageSmoothingEnabled = true;
  resizeCtx.imageSmoothingQuality = 'high';
  resizeCtx.drawImage(bitmap, 0, 0, resizedW, resizedH);
  return resizeCanvas;
}

/**
 * Browser path: CLIP views matching ttaViewPlan (center first).
 * @param {ImageBitmap} bitmap
 * @returns {Promise<Array<{name: string, chw: Float32Array}>>}
 */
export async function preprocessBitmapViews(bitmap) {
  const plan = ttaViewPlan(bitmap.width, bitmap.height);
  const canvases = new Map();
  const views = [];

  for (const step of plan) {
    const key = `${step.resizedW}x${step.resizedH}`;
    if (!canvases.has(key)) {
      canvases.set(key, resizeBitmapCanvas(bitmap, step.resizedW, step.resizedH));
    }
    views.push({
      name: step.name,
      chw: cropCanvas(canvases.get(key), step.sx, step.sy),
    });
  }

  return views;
}

/**
 * Browser path: official 440 center crop only.
 * @param {ImageBitmap} bitmap
 * @returns {Promise<Float32Array>}
 */
export async function preprocessBitmap(bitmap) {
  const { width: resizedW, height: resizedH } = resizeDimensions(bitmap.width, bitmap.height);
  const canvas = resizeBitmapCanvas(bitmap, resizedW, resizedH);
  const origin = cropOrigins(resizedW, resizedH)[0];
  return cropCanvas(canvas, origin.sx, origin.sy);
}

async function cropRawRgb(rawImage, sx, sy) {
  const cropped = await rawImage.crop([sx, sy, sx + CROP_SIZE - 1, sy + CROP_SIZE - 1]);
  if (cropped.width !== CROP_SIZE || cropped.height !== CROP_SIZE) {
    throw new Error(`Crop produced ${cropped.width}x${cropped.height}, expected ${CROP_SIZE}`);
  }
  return packedRgbToCHW(cropped.data, cropped.channels);
}

/**
 * Node eval path: CLIP views matching the extension.
 * @param {import('@huggingface/transformers').RawImage} rawImage
 * @returns {Promise<Array<{name: string, chw: Float32Array}>>}
 */
export async function preprocessRawImageViews(rawImage) {
  const plan = ttaViewPlan(rawImage.width, rawImage.height);
  const resizedByKey = new Map();
  const views = [];

  for (const step of plan) {
    const key = `${step.resizedW}x${step.resizedH}`;
    if (!resizedByKey.has(key)) {
      resizedByKey.set(key, await rawImage.resize(step.resizedW, step.resizedH));
    }
    const resized = resizedByKey.get(key);
    views.push({
      name: step.name,
      chw: await cropRawRgb(resized, step.sx, step.sy),
    });
  }

  return views;
}

/**
 * Node eval path using transformers.js RawImage helpers (official center crop).
 * @param {import('@huggingface/transformers').RawImage} rawImage
 * @returns {Promise<Float32Array>}
 */
export async function preprocessRawImage(rawImage) {
  const { width: resizedW, height: resizedH } = resizeDimensions(rawImage.width, rawImage.height);
  const resized = await rawImage.resize(resizedW, resizedH);
  const origin = cropOrigins(resizedW, resizedH)[0];
  return cropRawRgb(resized, origin.sx, origin.sy);
}
