/**
 * Browser-only C2PA reader using @contentauth/c2pa-web (local WASM + worker).
 * Falls back to null so heuristics can use byte scan.
 */

const C2PA_AI_URI = 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia';
const C2PA_COMPOSITE_URI =
  'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia';

let c2paSdk = null;
let c2paInitPromise = null;

function isExtensionContext() {
  return typeof chrome !== 'undefined' && chrome.runtime?.getURL;
}

async function ensureC2paSdk() {
  if (c2paSdk) return c2paSdk;
  if (!isExtensionContext()) return null;

  if (!c2paInitPromise) {
    c2paInitPromise = (async () => {
      const { createC2pa } = await import('@contentauth/c2pa-web');
      const wasmSrc = chrome.runtime.getURL('lib/c2pa_bg.wasm');
      const workerSrc = new URL(chrome.runtime.getURL('lib/c2pa_worker.js'));
      c2paSdk = await createC2pa({ wasmSrc, workerSrc });
      return c2paSdk;
    })().catch(() => null);
  }

  return c2paInitPromise;
}

/**
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {Promise<{ai: boolean, reason: string|null}|null>}
 */
export async function readC2paAiSignal(input) {
  if (!isExtensionContext()) return null;

  try {
    const c2pa = await ensureC2paSdk();
    if (!c2pa) return null;

    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const mime = sniffMime(bytes);
    const blob = new Blob([bytes], { type: mime });
    const reader = await c2pa.reader.fromBlob(mime, blob);
    if (!reader) return { ai: false, reason: null };

    try {
      const manifest = await reader.activeManifest();
      return walkManifestForAi(manifest);
    } finally {
      await reader.free();
    }
  } catch {
    return null;
  }
}

/**
 * @param {unknown} manifest
 */
function walkManifestForAi(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return { ai: false, reason: null };
  }

  const found = findDigitalSourceTypes(manifest);
  for (const dst of found) {
    if (dst.includes('compositeWithTrainedAlgorithmicMedia')) {
      return {
        ai: true,
        reason: 'C2PA digitalSourceType: composite with trained algorithmic media',
      };
    }
    if (dst.includes('trainedAlgorithmicMedia')) {
      return {
        ai: true,
        reason: 'C2PA digitalSourceType: trained algorithmic media',
      };
    }
  }

  return { ai: false, reason: null };
}

/**
 * @param {unknown} node
 * @param {Set<string>} out
 */
function findDigitalSourceTypes(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;

  if (Array.isArray(node)) {
    for (const item of node) findDigitalSourceTypes(item, out);
    return out;
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === 'digitalSourceType' && typeof value === 'string') {
      out.add(value);
    }
    if (typeof value === 'object' && value !== null) {
      findDigitalSourceTypes(value, out);
    }
  }

  return out;
}

function sniffMime(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
  return 'application/octet-stream';
}
