import {
  CLIP_MEAN,
  CLIP_STD,
  CROP_SIZE,
  SHORTEST_EDGE,
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
 * @param {ImageData} imageData 384x384 RGBA
 * @returns {Float32Array} CHW tensor length 3*384*384
 */
export function imageDataToCHW(imageData) {
  const { data, width, height } = imageData;
  if (width !== CROP_SIZE || height !== CROP_SIZE) {
    throw new Error(`Expected ${CROP_SIZE}x${CROP_SIZE} crop, got ${width}x${height}`);
  }

  const plane = width * height;
  const out = new Float32Array(3 * plane);

  for (let i = 0; i < plane; i++) {
    const offset = i * 4;
    const r = data[offset] / 255;
    const g = data[offset + 1] / 255;
    const b = data[offset + 2] / 255;

    out[i] = (r - CLIP_MEAN[0]) / CLIP_STD[0];
    out[i + plane] = (g - CLIP_MEAN[1]) / CLIP_STD[1];
    out[i + 2 * plane] = (b - CLIP_MEAN[2]) / CLIP_STD[2];
  }

  return out;
}

/**
 * Browser path: resize shortest edge to 440, center-crop 384, CLIP normalize.
 * @param {ImageBitmap} bitmap
 * @returns {Promise<Float32Array>}
 */
export async function preprocessBitmap(bitmap) {
  const { width: resizedW, height: resizedH } = resizeDimensions(bitmap.width, bitmap.height);

  const resizeCanvas = new OffscreenCanvas(resizedW, resizedH);
  const resizeCtx = resizeCanvas.getContext('2d', { willReadFrequently: true });
  resizeCtx.drawImage(bitmap, 0, 0, resizedW, resizedH);

  const cropCanvas = new OffscreenCanvas(CROP_SIZE, CROP_SIZE);
  const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });
  const sx = Math.floor((resizedW - CROP_SIZE) / 2);
  const sy = Math.floor((resizedH - CROP_SIZE) / 2);
  cropCtx.drawImage(
    resizeCanvas,
    sx,
    sy,
    CROP_SIZE,
    CROP_SIZE,
    0,
    0,
    CROP_SIZE,
    CROP_SIZE
  );

  const imageData = cropCtx.getImageData(0, 0, CROP_SIZE, CROP_SIZE);
  return imageDataToCHW(imageData);
}

/**
 * Node eval path using transformers.js RawImage helpers.
 * @param {import('@huggingface/transformers').RawImage} rawImage
 * @returns {Promise<Float32Array>}
 */
export async function preprocessRawImage(rawImage) {
  const { width: resizedW, height: resizedH } = resizeDimensions(rawImage.width, rawImage.height);
  const resized = await rawImage.resize(resizedW, resizedH);
  const cropped = await resized.center_crop(CROP_SIZE, CROP_SIZE);

  const plane = CROP_SIZE * CROP_SIZE;
  const out = new Float32Array(3 * plane);
  const data = cropped.data;
  const channels = cropped.channels;

  for (let i = 0; i < plane; i++) {
    const base = i * channels;
    const r = data[base] / 255;
    const g = data[base + 1] / 255;
    const b = data[base + 2] / 255;

    out[i] = (r - CLIP_MEAN[0]) / CLIP_STD[0];
    out[i + plane] = (g - CLIP_MEAN[1]) / CLIP_STD[1];
    out[i + 2 * plane] = (b - CLIP_MEAN[2]) / CLIP_STD[2];
  }

  return out;
}
