import { env, pipeline } from '@huggingface/transformers';
import { analyzeHeuristics, neuralPAiFromClassification, topGeneratorHint } from './heuristics.js';
import { fuseScores, DEFAULT_THRESHOLD } from './fuse.js';

const MODEL_ID = 'onnx-community/ai-source-detector-ONNX';
const HF_CACHE_NAME = 'hybrid-ai-detector-model-v1';
const HF_FILES = [
  'onnx/model_quantized.onnx',
  'config.json',
  'preprocessor_config.json',
];

let classifier = null;
let initError = null;
let threshold = DEFAULT_THRESHOLD;

function configureEnv() {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = chrome.runtime.getURL('models/');
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('lib/');
  env.useBrowserCache = false;
  env.useCustomCache = false;
}

async function modelFilesPresent() {
  const checks = HF_FILES.map(async (file) => {
    const url = chrome.runtime.getURL(`models/${MODEL_ID}/${file}`);
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  });
  const results = await Promise.all(checks);
  return results.every(Boolean);
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

async function ensureClassifier() {
  if (classifier) return classifier;
  if (initError) throw initError;

  configureEnv();

  const localReady = await modelFilesPresent();
  if (!localReady) {
    try {
      await downloadToCacheStorage();
      env.allowRemoteModels = true;
      env.remoteModelPath = `https://huggingface.co/${MODEL_ID}/resolve/main`;
    } catch (err) {
      initError = err;
      throw err;
    }
  }

  const device = navigator.gpu ? 'webgpu' : 'wasm';

  try {
    classifier = await pipeline('image-classification', MODEL_ID, {
      device,
      dtype: 'q8',
    });
    env.allowRemoteModels = false;
    return classifier;
  } catch (err) {
    initError = err;
    throw err;
  }
}

async function classifyImage(buffer, url, customThreshold) {
  const bytes = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
  const heuristics = await analyzeHeuristics(bytes, url);

  let neuralPAi = 0.5;
  let generatorHint = null;
  let modelError = null;

  try {
    const pipe = await ensureClassifier();
    const mime = sniffMime(bytes);
    const blob = new Blob([bytes], { type: mime });
    const objectUrl = URL.createObjectURL(blob);
    try {
      const outputs = await pipe(objectUrl);
      neuralPAi = neuralPAiFromClassification(outputs);
      generatorHint = topGeneratorHint(outputs);
    } finally {
      URL.revokeObjectURL(objectUrl);
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
    generatorHint,
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
        await ensureClassifier();
        sendResponse({ ok: true, device: navigator.gpu ? 'webgpu' : 'wasm' });
        return;
      }

      if (message.type === 'analyze') {
        if (typeof message.threshold === 'number') threshold = message.threshold;
        const buffer = message.buffer;
        const result = await classifyImage(buffer, message.url || '', message.threshold);
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
