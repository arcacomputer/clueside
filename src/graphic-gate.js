/** Native-crop pixel stats for flat graphics, icons, and catalog UI art. */

export const GRAPHIC_FLAT_HIGH = 0.62;
export const GRAPHIC_FLAT_MID = 0.56;
export const GRAPHIC_PALETTE_LOW = 0.5;
export const GRAPHIC_SAMPLE_MAX = 384;

/**
 * Score flat horizontal runs and a quantized palette on RGBA pixels.
 * @param {Uint8Array|Uint8ClampedArray} rgba width * height * 4
 * @param {number} width
 * @param {number} height
 */
export function analyzeGraphicPixels(rgba, width, height) {
  if (!rgba?.length || width < 2 || height < 1) {
    return { isGraphic: false, flatFrac: 0, paletteFrac: 0 };
  }

  let flat = 0;
  const palette = new Set();

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = (row + x) * 4;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      palette.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));

      if (x + 1 < width) {
        const j = i + 4;
        if (
          r === rgba[j] &&
          g === rgba[j + 1] &&
          b === rgba[j + 2]
        ) {
          flat += 1;
        }
      }
    }
  }

  const flatFrac = flat / (height * (width - 1));
  const paletteFrac = palette.size / 1024;
  const isGraphic =
    flatFrac > GRAPHIC_FLAT_HIGH ||
    (flatFrac > GRAPHIC_FLAT_MID && paletteFrac < GRAPHIC_PALETTE_LOW);

  return { isGraphic, flatFrac, paletteFrac };
}

/**
 * Apply the browser gate to packed RGB/RGBA pixels, using the same native-size
 * center crop as analyzeGraphicGate(). This keeps Node evaluation aligned with
 * the extension without adding a canvas dependency.
 * @param {Uint8Array|Uint8ClampedArray} data width * height * channels
 * @param {number} width
 * @param {number} height
 * @param {number} [channels]
 */
export function analyzeGraphicPackedPixels(data, width, height, channels) {
  const inferredChannels =
    Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
      ? data?.length / (width * height)
      : 0;
  const channelCount = Number.isInteger(channels) ? channels : inferredChannels;
  if (
    !data?.length ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    !Number.isInteger(channelCount) ||
    width < 1 ||
    height < 1 ||
    channelCount < 3 ||
    data.length < width * height * channelCount
  ) {
    return { isGraphic: false, flatFrac: 0, paletteFrac: 0 };
  }

  const cropWidth = Math.min(GRAPHIC_SAMPLE_MAX, width);
  const cropHeight = Math.min(GRAPHIC_SAMPLE_MAX, height);
  const startX = Math.floor((width - cropWidth) / 2);
  const startY = Math.floor((height - cropHeight) / 2);
  const rgba = new Uint8ClampedArray(cropWidth * cropHeight * 4);

  for (let y = 0; y < cropHeight; y++) {
    for (let x = 0; x < cropWidth; x++) {
      const source = ((startY + y) * width + startX + x) * channelCount;
      const target = (y * cropWidth + x) * 4;
      rgba[target] = data[source];
      rgba[target + 1] = data[source + 1];
      rgba[target + 2] = data[source + 2];
      rgba[target + 3] = channelCount > 3 ? data[source + 3] : 255;
    }
  }

  return analyzeGraphicPixels(rgba, cropWidth, cropHeight);
}

/**
 * Sample a native-resolution center crop from a decoded bitmap.
 * @param {ImageBitmap} bitmap
 */
export function analyzeGraphicGate(bitmap) {
  const cw = Math.min(GRAPHIC_SAMPLE_MAX, bitmap.width);
  const ch = Math.min(GRAPHIC_SAMPLE_MAX, bitmap.height);
  const canvas = new OffscreenCanvas(cw, ch);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    bitmap,
    Math.floor((bitmap.width - cw) / 2),
    Math.floor((bitmap.height - ch) / 2),
    cw,
    ch,
    0,
    0,
    cw,
    ch
  );
  const { data } = ctx.getImageData(0, 0, cw, ch);
  return analyzeGraphicPixels(data, cw, ch);
}
