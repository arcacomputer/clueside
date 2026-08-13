import { analyzeHeuristics } from './heuristics.js';
import { fuseScores, DEFAULT_THRESHOLD } from './fuse.js';
import { preprocessBitmap } from './clip-preprocess.js';
import {
  createCommunityForensicsSession,
  predictCHW,
  MODEL_ID,
  MODEL_ONNX_PATH,
} from './community-forensics.js';

const HF_CACHE_NAME = 'hybrid-ai-detector-model-v1';
const HF_FILES = [MODEL_ONNX_PATH, 'preprocessor_config.json', 'config.json'];

let session = null;
let initError = null;
let threshold = DEFAULT_THRESHOLD;

async function modelFilesPresent() {
  const checks = HF_FILES.map(async (file) => {
    const url = chrome.runtime.getURL(`models/${MODEL_ID}/${file}`);
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  });
  return (await Promise.all(checks)).every(Boolean);
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
  if (session) return session;
  if (initError) throw initError;

  try {
    if (!(await modelFilesPresent())) {
      await downloadToCacheStorage();
    }

    const modelUrl = chrome.runtime.getURL(`models/${MODEL_ID}/${MODEL_ONNX_PATH}`);
    session = await createCommunityForensicsSession({
      modelUrl,
      wasmPaths: chrome.runtime.getURL('lib/'),
      useWebGpu: Boolean(navigator.gpu),
    });
    return session;
  } catch (err) {
    initError = err;
    throw err;
  }
}

async function classifyImage(buffer, url, customThreshold) {
  const bytes = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
  const heuristics = await analyzeHeuristics(bytes, url);

  let neuralPAi = 0.5;
  let modelError = null;

  try {
    const activeSession = await ensureSession();
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
      if (message.type === 'init') {
        if (typeof message.threshold === 'number') threshold = message.threshold;
        await ensureSession();
        sendResponse({ ok: true, device: navigator.gpu ? 'webgpu' : 'wasm' });
        return;
      }

      if (message.type === 'analyze') {
        if (typeof message.threshold === 'number') threshold = message.threshold;
        const result = await classifyImage(message.buffer, message.url || '', message.threshold);
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
  const u8 = new Uint8Array(bytes instanceof ArrayBuffer ? bytes : bytes.buffer);
  if (u8[0] === 0x89 && u8[1] === 0x50) return 'image/png';
  if (u8[0] === 0xff && u8[1] === 0xd8) return 'image/jpeg';
  if (u8[0] === 0x47 && u8[1] === 0x49) return 'image/gif';
  if (u8[8] === 0x57 && u8[9] === 0x45) return 'image/webp';
  return 'image/jpeg';
}
