import {
  CLIP_MEAN,
  CLIP_STD,
  CROP_SIZE,
  SHORTEST_EDGE,
  TTA_EXTRA_SHORTEST_EDGE,
} from './models.js';
import { pillowResize } from './pixel-resize.js';
import { MAX_CANVAS_SIDE, MAX_IMAGE_PIXELS } from './image-limits.js';

// NOTE: src/dino.js keeps its own canvas / RawImage resize path on purpose;
// the DINO probe was trained against it and changing it without retraining
// adds skew. Only the CommunityForensics path below uses pillowResize.

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

/**
 * Copy a CROP_SIZE window out of a packed row-major pixel buffer.
 * @param {Uint8Array|Uint8ClampedArray} data width * height * channels
 * @param {number} width
 * @param {number} height
 * @param {number} channels
 * @param {number} sx
 * @param {number} sy
 * @returns {Uint8ClampedArray} CROP_SIZE * CROP_SIZE * channels
 */
export function cropPackedPixels(data, width, height, channels, sx, sy) {
  if (sx < 0 || sy < 0 || sx + CROP_SIZE > width || sy + CROP_SIZE > height) {
    throw new Error(
      `Crop ${CROP_SIZE} at ${sx},${sy} does not fit inside ${width}x${height}`
    );
  }

  const rowLength = CROP_SIZE * channels;
  const out = new Uint8ClampedArray(CROP_SIZE * rowLength);
  for (let y = 0; y < CROP_SIZE; y++) {
    const start = ((sy + y) * width + sx) * channels;
    out.set(data.subarray(start, start + rowLength), y * rowLength);
  }
  return out;
}

/**
 * Shared CF view builder: Pillow-exact resize once per target size, then
 * typed-array window crops. Identical for browser RGBA and Node RawImage
 * pixels, which is the whole point of the pillowResize migration.
 * @param {Uint8Array|Uint8ClampedArray} data
 * @param {number} width
 * @param {number} height
 * @param {number} channels
 * @param {Array<{name: string, sx: number, sy: number, resizedW: number, resizedH: number}>} plan
 * @returns {Array<{name: string, chw: Float32Array}>}
 */
function packedPlanViews(data, width, height, channels, plan) {
  const resizedByKey = new Map();
  const views = [];

  for (const step of plan) {
    const key = `${step.resizedW}x${step.resizedH}`;
    if (!resizedByKey.has(key)) {
      resizedByKey.set(
        key,
        pillowResize(data, width, height, channels, step.resizedW, step.resizedH)
      );
    }
    const crop = cropPackedPixels(
      resizedByKey.get(key),
      step.resizedW,
      step.resizedH,
      channels,
      step.sx,
      step.sy
    );
    views.push({ name: step.name, chw: packedRgbToCHW(crop, channels) });
  }

  return views;
}

/**
 * True when a bitmap is too large to read back at native size: over the
 * decoded-pixel cap, or with a side beyond Chrome's canvas limit (where
 * getImageData silently returns transparent black). Exported for tests.
 * @param {number} width
 * @param {number} height
 */
export function needsCanvasFallback(width, height) {
  return (
    width * height > MAX_IMAGE_PIXELS ||
    width > MAX_CANVAS_SIDE ||
    height > MAX_CANVAS_SIDE
  );
}

/**
 * Read the full native-size RGBA pixels of a decoded bitmap exactly once.
 * Callers must check needsCanvasFallback first.
 * @param {ImageBitmap} bitmap
 * @returns {Uint8ClampedArray} bitmap.width * bitmap.height * 4
 */
function bitmapToPackedRgba(bitmap) {
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // 1:1 blit at native size; no canvas resampling is involved in the CF
  // path for in-cap bitmaps. The model was trained on PIL bicubic, and
  // pillowResize reproduces it byte for byte in both browser and Node.
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, width, height).data;
}

/**
 * Legacy canvas resize, kept only for bitmaps that cannot be read back at
 * native size (see needsCanvasFallback). This is exactly the pre-Pillow
 * shipped behavior: GPU drawImage with high smoothing straight to the
 * target dims, so monster images keep scoring instead of erroring. The
 * target canvas is always small, far below every canvas limit.
 * @param {ImageBitmap} bitmap
 * @param {number} resizedW
 * @param {number} resizedH
 * @returns {Uint8ClampedArray} resizedW * resizedH * 4
 */
function fallbackCanvasResize(bitmap, resizedW, resizedH) {
  const canvas = new OffscreenCanvas(resizedW, resizedH);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, resizedW, resizedH);
  return ctx.getImageData(0, 0, resizedW, resizedH).data;
}

/**
 * Browser path: CLIP views matching ttaViewPlan (center first).
 * @param {ImageBitmap} bitmap
 * @returns {Promise<Array<{name: string, chw: Float32Array}>>}
 */
export async function preprocessBitmapViews(bitmap) {
  const plan = ttaViewPlan(bitmap.width, bitmap.height);

  if (needsCanvasFallback(bitmap.width, bitmap.height)) {
    const resizedByKey = new Map();
    const views = [];
    for (const step of plan) {
      const key = `${step.resizedW}x${step.resizedH}`;
      if (!resizedByKey.has(key)) {
        resizedByKey.set(key, fallbackCanvasResize(bitmap, step.resizedW, step.resizedH));
      }
      const crop = cropPackedPixels(
        resizedByKey.get(key),
        step.resizedW,
        step.resizedH,
        4,
        step.sx,
        step.sy
      );
      views.push({ name: step.name, chw: packedRgbToCHW(crop, 4) });
    }
    return views;
  }

  const rgba = bitmapToPackedRgba(bitmap);
  return packedPlanViews(rgba, bitmap.width, bitmap.height, 4, plan);
}

/**
 * Browser path: official 440 center crop only.
 * @param {ImageBitmap} bitmap
 * @returns {Promise<Float32Array>}
 */
export async function preprocessBitmap(bitmap) {
  const { width: resizedW, height: resizedH } = resizeDimensions(bitmap.width, bitmap.height);
  const origin = cropOrigins(resizedW, resizedH)[0];

  if (needsCanvasFallback(bitmap.width, bitmap.height)) {
    const resized = fallbackCanvasResize(bitmap, resizedW, resizedH);
    const crop = cropPackedPixels(resized, resizedW, resizedH, 4, origin.sx, origin.sy);
    return packedRgbToCHW(crop, 4);
  }

  const rgba = bitmapToPackedRgba(bitmap);
  const resized = pillowResize(rgba, bitmap.width, bitmap.height, 4, resizedW, resizedH);
  const crop = cropPackedPixels(resized, resizedW, resizedH, 4, origin.sx, origin.sy);
  return packedRgbToCHW(crop, 4);
}

/**
 * Node eval path: CLIP views matching the extension. Feeds the raw packed
 * pixels straight into the same pillowResize the browser path uses.
 * Grayscale sources (channels < 3) flow through unchanged; packedRgbToCHW
 * replicates the single channel instead of reading past the pixel.
 * @param {import('@huggingface/transformers').RawImage} rawImage
 * @returns {Promise<Array<{name: string, chw: Float32Array}>>}
 */
export async function preprocessRawImageViews(rawImage) {
  const plan = ttaViewPlan(rawImage.width, rawImage.height);
  return packedPlanViews(
    rawImage.data,
    rawImage.width,
    rawImage.height,
    rawImage.channels,
    plan
  );
}

/**
 * Node eval path (official center crop), same pixels-in pixels-out route
 * as preprocessRawImageViews.
 * @param {import('@huggingface/transformers').RawImage} rawImage
 * @returns {Promise<Float32Array>}
 */
export async function preprocessRawImage(rawImage) {
  const { width: resizedW, height: resizedH } = resizeDimensions(rawImage.width, rawImage.height);
  const resized = pillowResize(
    rawImage.data,
    rawImage.width,
    rawImage.height,
    rawImage.channels,
    resizedW,
    resizedH
  );
  const origin = cropOrigins(resizedW, resizedH)[0];
  const crop = cropPackedPixels(
    resized,
    resizedW,
    resizedH,
    rawImage.channels,
    origin.sx,
    origin.sy
  );
  return packedRgbToCHW(crop, rawImage.channels);
}
