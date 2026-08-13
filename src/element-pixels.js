/**
 * Read pixels from an already-decoded <img> without any network fetch.
 * This is the rescue path when original bytes are unreachable: file://
 * galleries, offline eval pages whose re-fetch is blocked, and
 * credentialed/hotlink-protected CDNs.
 *
 * The result is a lossless PNG re-encode of the decoded pixels, so
 * EXIF/C2PA metadata is NOT present. Callers must prefer an
 * original-bytes path first and use this only after it fails.
 */

/** Downscale very large photos before PNG re-encode; the model only
 * needs shortest-edge 512 for its largest view. */
export const MAX_SHORTEST_EDGE = 1024;

/** Panoramas can have a tiny shortest edge but a huge long edge. */
export const MAX_LONGEST_EDGE = 4096;

/**
 * @param {number} width
 * @param {number} height
 * @returns {{width: number, height: number}}
 */
export function encodeDimensions(width, height) {
  let w = width;
  let h = height;

  const applyScale = (scale) => {
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  };

  const shortest = Math.min(w, h);
  if (shortest > MAX_SHORTEST_EDGE) {
    applyScale(MAX_SHORTEST_EDGE / shortest);
  }

  const longest = Math.max(w, h);
  if (longest > MAX_LONGEST_EDGE) {
    applyScale(MAX_LONGEST_EDGE / longest);
  }

  return { width: w, height: h };
}

/**
 * True when an analyze outcome should trigger the element-pixels rescue:
 * the bytes never made it to inference (fetch blocked/timed out, scheme
 * unsupported), as opposed to inference itself failing on good bytes.
 * @param {{ skipped?: boolean, reason?: string, error?: string } | null | undefined} result
 * @param {(msg: string) => boolean} isFetchSkip
 */
export function shouldTryElementPixels(result, isFetchSkip) {
  if (!result) return false;
  if (result.skipped && !/too small|disabled/i.test(result.reason || '')) return true;
  if (result.error && isFetchSkip(result.error)) return true;
  return false;
}

/**
 * @param {HTMLImageElement} el decoded image element
 * @returns {Promise<ArrayBuffer>} lossless PNG bytes of the decoded pixels
 */
export async function readElementPixels(el) {
  if (!el?.naturalWidth || !el?.naturalHeight) {
    throw new Error('Image not decoded yet');
  }

  const bitmap = await createImageBitmap(el);
  try {
    const { width, height } = encodeDimensions(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);
    // Throws SecurityError when the canvas is tainted (cross-origin
    // image without CORS). That means pixels are not readable; rethrow
    // so the caller keeps the skip badge.
    ctx.getImageData(0, 0, 1, 1);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return blob.arrayBuffer();
  } finally {
    bitmap.close();
  }
}
