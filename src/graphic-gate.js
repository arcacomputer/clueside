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
    (bitmap.width - cw) / 2,
    (bitmap.height - ch) / 2,
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
