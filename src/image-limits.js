export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGE_BASE64_CHARS = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);

/**
 * Decoded-pixel cap for the CF preprocess, which reads the full native
 * bitmap once (getImageData) before the Pillow-exact resize. The 12 MiB
 * encoded cap does not bound decoded size: a dense JPEG can decode far
 * larger than its byte count suggests. 64 MiPixels is 256 MiB of RGBA.
 * Bitmaps above this cap fall back to the legacy canvas resize instead of
 * erroring, so oversized images keep scoring like they did before the
 * Pillow-exact path landed.
 */
export const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;

/**
 * Chrome caps a canvas side at 65,535 device pixels; a native-size canvas
 * beyond that silently reads back transparent black. Any bitmap with a
 * longer side must use the legacy canvas fallback, which only ever
 * allocates the small resized target.
 */
export const MAX_CANVAS_SIDE = 65535;

/**
 * Read a fetch response without allowing a missing or dishonest
 * Content-Length header to allocate an unbounded image buffer.
 * @param {Response} response
 * @param {number} [maxBytes]
 */
export async function readResponseBytes(response, maxBytes = MAX_IMAGE_BYTES) {
  const declared = Number(response.headers?.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('Image exceeds size cap');

  if (!response.body?.getReader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new Error('Image exceeds size cap');
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel('Image exceeds size cap');
        } catch {
          // The limit error below is the useful result.
        }
        throw new Error('Image exceeds size cap');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}
