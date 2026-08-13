/**
 * Prefer the URL the browser is actually showing (lazy srcset / CDN).
 * @param {{ currentSrc?: string, src?: string, complete?: boolean }} el
 */
export function pickImageUrl(el) {
  if (!el) return '';
  if (el.currentSrc) return el.currentSrc;
  if (el.complete && el.src) return el.src;
  return '';
}
