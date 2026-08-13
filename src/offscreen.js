import { analyzeHeuristics } from './heuristics.js';
import { fuseScores, DEFAULT_THRESHOLD } from './fuse.js';
import { preprocessBitmap } from './clip-preprocess.js';
import { base64ToBytes, toArrayBuffer } from './bytes.js';
import {
  createCommunityForensicsSession,
  predictCHW,
  probeWebGpuAdapter,
  assetReachable,
  MODEL_ID,
  MODEL_ONNX_PATH,
} from './community-forensics.js';

const HF_CACHE_NAME = 'hybrid-ai-detector-model-v1';
const HF_FILES = [MODEL_ONNX_PATH, 'preprocessor_config.json', 'config.json'];
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

let session = null;
let sessionDevice = 'wasm';
let initError = null;
let sessionPromise = null;
let threshold = DEFAULT_THRESHOLD;

async function modelFileReachable(file) {
  const url = chrome.runtime.getURL(`models/${MODEL_ID}/${file}`);
  return assetReachable(url);
}

async function modelFilesPresent() {
  const checks = await Promise.all(HF_FILES.map((file) => modelFileReachable(file)));
  return checks.every(Boolean);
}

async function downloadToCacheStorage() {
  const base = `https://huggingface.co/${MODEL_ID}/resolve/main`;
  const cache = await caches.open(HF_CACHE_NAME);

  for (const file of HF_FILES) {
    const url = `${base}/${file}`;
    const cached = await cache.match(url);
    if (cached) continue;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to download ${file}: ${res.status}`);
    }
    await cache.put(url, res.clone());
  }
}

async function ensureSession() {
  if (session) return { session, device: sessionDevice };
  if (sessionPromise) return sessionPromise;
  if (initError) throw initError;

  sessionPromise = (async () => {
    if (!(await modelFilesPresent())) {
      await downloadToCacheStorage();
      if (!(await modelFilesPresent())) {
        throw new Error('Model weights missing. Run npm run fetch-model and rebuild.');
      }
    }

    const modelUrl = chrome.runtime.getURL(`models/${MODEL_ID}/${MODEL_ONNX_PATH}`);
    const adapter = await probeWebGpuAdapter();
    const created = await createCommunityForensicsSession({
      modelUrl,
      wasmPaths: chrome.runtime.getURL('lib/'),
      preferWebGpu: Boolean(adapter),
    });

    session = created.session;
    sessionDevice = created.device;
    return created;
  })();

  try {
    return await sessionPromise;
  } catch (err) {
    initError = err;
    sessionPromise = null;
    throw err;
  }
}

async function fetchImageBytes(url) {
  const res = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
  if (!res.ok) {
    throw new Error(`Image fetch failed (${res.status})`);
  }

  const type = res.headers.get('content-type') || '';
  if (type && !type.startsWith('image/')) {
    throw new Error(`Not an image content-type (${type})`);
  }

  const cl = Number(res.headers.get('content-length') || 0);
  if (cl > MAX_IMAGE_BYTES) {
    throw new Error('Image exceeds size cap');
  }

  const buffer = await res.arrayBuffer();
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('Image exceeds size cap');
  }

  return buffer;
}

/**
 * Resolve image bytes from the message. sendMessage JSON-serializes
 * payloads, so raw ArrayBuffers never arrive here. Accepted transports:
 * base64 (blob/data URLs and file drops) or an http(s) URL that this
 * offscreen document fetches itself.
 * @param {{ bufferB64?: string, url?: string }} message
 * @returns {Promise<ArrayBuffer>}
 */
async function resolveImageBytes(message) {
  if (typeof message.bufferB64 === 'string' && message.bufferB64.length > 0) {
    const bytes = base64ToBytes(message.bufferB64);
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error('Image exceeds size cap');
    }
    if (bytes.byteLength === 0) {
      throw new Error('Empty image payload');
    }
    return toArrayBuffer(bytes);
  }

  if (typeof message.url === 'string' && /^https?:\/\//i.test(message.url)) {
    return fetchImageBytes(message.url);
  }

  throw new Error('No image bytes received (missing bufferB64 and non-http URL)');
}

async function classifyImage(rawBytes, url, customThreshold) {
  const bytes = toArrayBuffer(rawBytes);
  const heuristics = await analyzeHeuristics(bytes, url);

  let neuralPAi = 0.5;
  let modelError = null;

  try {
    const { session: activeSession } = await ensureSession();
    const mime = sniffMime(bytes);
    const blob = new Blob([bytes], { type: mime });
    const bitmap = await createImageBitmap(blob);
    try {
      const chw = await preprocessBitmap(bitmap);
      neuralPAi = await predictCHW(activeSession, chw);
    } finally {
      bitmap.close();
    }
  } catch (err) {
    modelError = err.message || String(err);
    if (heuristics.c2paAi || heuristics.metadataAi) {
      neuralPAi = 0.5;
    } else {
      throw err;
    }
  }

  const fused = fuseScores(neuralPAi, heuristics, customThreshold ?? threshold);

  return {
    ...fused,
    generatorHint: null,
    modelError,
    url,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'offscreen') return false;

  (async () => {
    try {
      if (message.type === 'ping') {
        sendResponse({ ok: true, ready: Boolean(session) });
        return;
      }

      if (message.type === 'init') {
        if (typeof message.threshold === 'number') threshold = message.threshold;
        const { device } = await ensureSession();
        sendResponse({ ok: true, device });
        return;
      }

      if (message.type === 'analyze') {
        if (typeof message.threshold === 'number') threshold = message.threshold;
        const bytes = await resolveImageBytes(message);
        const result = await classifyImage(bytes, message.url || '', message.threshold);
        sendResponse({ ok: true, result });
        return;
      }

      sendResponse({ ok: false, error: 'Unknown message type' });
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();

  return true;
});

console.log('Hybrid AI Image Detector offscreen ready');

function sniffMime(bytes) {
  const buf = toArrayBuffer(bytes);
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0x89 && u8[1] === 0x50) return 'image/png';
  if (u8[0] === 0xff && u8[1] === 0xd8) return 'image/jpeg';
  if (u8[0] === 0x47 && u8[1] === 0x49) return 'image/gif';
  if (u8[8] === 0x57 && u8[9] === 0x45) return 'image/webp';
  return 'image/jpeg';
}
