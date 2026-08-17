import * as ort from 'onnxruntime-web';
import { analyzeHeuristics } from './heuristics.js';
import { DEFAULT_THRESHOLD } from './fuse.js';
import { preprocessBitmap, preprocessBitmapViews } from './clip-preprocess.js';
import { base64ToBytes, toArrayBuffer } from './bytes.js';
import { analyzeGraphicGate } from './graphic-gate.js';
import { effectiveTtaMode, fuseInferenceScores } from './inference-policy.js';
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_BASE64_CHARS,
  readResponseBytes,
} from './image-limits.js';
import {
  configureOrtLogging,
  createCommunityForensicsSession,
  predictAdaptiveViews,
  predictCHW,
  probeWebGpuAdapter,
  assetReachable,
  MODEL_ID,
  MODEL_ONNX_PATH,
  ORT_SESSION_LOG_OPTIONS,
} from './community-forensics.js';
import {
  DINO_MODEL_ID,
  DINO_ONNX_PATH,
  DINO_INPUT_NAME,
  DINO_CROP_SIZE,
  dinoPreprocessBitmap,
  dinoScoreHiddenState,
} from './dino.js';
import { FETCH_TIMEOUT_MS, INFERENCE_TIMEOUT_MS } from './analyze-retry.js';
import {
  createExclusiveLock,
  normalizeTtaMode,
  runExclusiveAfterStart,
} from './analyze-queue.js';
import {
  createWebGpuHealth,
  isWebGpuDeviceError,
  isWedgeError,
  shouldFallBackToWasm,
  wrapSessionWithWatchdog,
} from './webgpu-watchdog.js';

const HF_FILES = [MODEL_ONNX_PATH, 'preprocessor_config.json', 'config.json'];
const PROBE_URL_PATH = 'models/probe/dino-probe.json';

let session = null;
let sessionDevice = 'wasm';
let dinoSession = null;
let dinoProbe = null;
let initError = null;
let sessionPromise = null;
let threshold = DEFAULT_THRESHOLD;
const inferLock = createExclusiveLock();

// Runtime WebGPU recovery (live smoke of v1.3.1: a wedged WebGPU run under
// GPU contention left 104 badges pending). One-way for the lifetime of this
// offscreen document: once WebGPU wedges or the device is lost, both
// sessions are rebuilt on WASM and never flap back.
const webGpuHealth = createWebGpuHealth();
let rawCfSession = null;
let rawDinoSession = null;
let wasmFallbackPromise = null;

/**
 * Multithreaded WASM needs SharedArrayBuffer, which needs the COOP/COEP
 * headers declared in manifest.json. Feature-detect so a Chrome that
 * does not isolate extension pages still works on one thread.
 */
function wasmThreadCount() {
  if (!globalThis.crossOriginIsolated) return 1;
  const cores = navigator.hardwareConcurrency || 2;
  return Math.max(1, Math.min(4, cores - 1));
}

async function modelFileReachable(file) {
  const url = chrome.runtime.getURL(`models/${MODEL_ID}/${file}`);
  return assetReachable(url);
}

async function modelFilesPresent() {
  const checks = await Promise.all(HF_FILES.map((file) => modelFileReachable(file)));
  return checks.every(Boolean);
}

/**
 * The DINOv2 head is optional at runtime: if its assets are missing the
 * extension degrades to CommunityForensics-only instead of failing.
 */
async function tryCreateDinoHead() {
  try {
    const probeRes = await fetch(chrome.runtime.getURL(PROBE_URL_PATH));
    if (!probeRes.ok) throw new Error(`probe fetch ${probeRes.status}`);
    const probe = await probeRes.json();

    const modelUrl = chrome.runtime.getURL(`models/${DINO_MODEL_ID}/${DINO_ONNX_PATH}`);
    if (!(await assetReachable(modelUrl))) throw new Error('dino model missing');

    configureOrtLogging();
    const created = await ort.InferenceSession.create(modelUrl, {
      executionProviders: sessionDevice === 'webgpu' ? ['webgpu'] : ['wasm'],
      ...ORT_SESSION_LOG_OPTIONS,
    }).catch(() =>
      ort.InferenceSession.create(modelUrl, {
        executionProviders: ['wasm'],
        ...ORT_SESSION_LOG_OPTIONS,
      })
    );

    rawDinoSession = created;
    dinoSession = sessionDevice === 'webgpu' ? wrapSessionWithWatchdog(created) : created;
    dinoProbe = probe;
    console.log('DINOv2 probe head ready');
  } catch (err) {
    console.debug('DINOv2 head unavailable, running CommunityForensics only:', err?.message || err);
    rawDinoSession = null;
    dinoSession = null;
    dinoProbe = null;
  }
}

/**
 * GPUDevice.lost resolves (it never rejects) when the device goes away.
 * onnxruntime-web keeps one shared device on ort.env.webgpu after a WebGPU
 * session exists. Marking the latch here means the next analyze rebuilds on
 * WASM before it ever starts another WebGPU run.
 */
function watchGpuDeviceLoss() {
  let lost;
  try {
    lost = ort.env?.webgpu?.device?.lost;
  } catch {
    return;
  }
  if (typeof lost?.then !== 'function') return;
  lost
    .then((info) => {
      webGpuHealth.markUnhealthy(`GPUDevice lost (${info?.reason || 'unknown'})`);
    })
    .catch(() => {});
}

async function ensureSession() {
  if (session) return { session, device: sessionDevice };
  if (sessionPromise) return sessionPromise;
  if (initError) throw initError;

  sessionPromise = (async () => {
    if (!(await modelFilesPresent())) {
      // All weights ship inside the extension (release zip / fetch-model
      // at build time). There is deliberately no runtime download path:
      // after install the extension never touches the network.
      throw new Error('Model weights missing. Run npm run fetch-model and rebuild.');
    }

    const modelUrl = chrome.runtime.getURL(`models/${MODEL_ID}/${MODEL_ONNX_PATH}`);
    const adapter = webGpuHealth.isUnhealthy() ? null : await probeWebGpuAdapter();
    const created = await createCommunityForensicsSession({
      modelUrl,
      wasmPaths: chrome.runtime.getURL('lib/'),
      preferWebGpu: Boolean(adapter) && !webGpuHealth.isUnhealthy(),
      numThreads: wasmThreadCount(),
    });

    rawCfSession = created.session;
    sessionDevice = created.device;
    session =
      created.device === 'webgpu' ? wrapSessionWithWatchdog(created.session) : created.session;
    if (created.device === 'webgpu') watchGpuDeviceLoss();

    await tryCreateDinoHead();

    return { session, device: sessionDevice };
  })();

  try {
    return await sessionPromise;
  } catch (err) {
    initError = err;
    sessionPromise = null;
    throw err;
  }
}

/**
 * One-way WebGPU to WASM fallback. Disposes both (possibly wedged) sessions
 * without awaiting them, rebuilds both on the WASM execution provider, and
 * logs the switch exactly once. The caller retries the in-flight image;
 * everything still waiting behind the inference lock or in the page queue
 * simply runs on the rebuilt WASM sessions. There is no path back to WebGPU
 * until the offscreen document restarts.
 * @param {string} reason
 */
function fallbackToWasm(reason) {
  if (wasmFallbackPromise) return wasmFallbackPromise;

  webGpuHealth.markUnhealthy(reason);
  console.warn(
    `Clueside: WebGPU backend unhealthy (${webGpuHealth.reason()}). ` +
      'Rebuilding both model sessions on WASM for the rest of this browser session.'
  );

  wasmFallbackPromise = (async () => {
    // Fire-and-forget disposal: release on a wedged device can itself hang.
    try {
      Promise.resolve(rawCfSession?.release?.()).catch(() => {});
    } catch {
      // Session already unusable.
    }
    try {
      Promise.resolve(rawDinoSession?.release?.()).catch(() => {});
    } catch {
      // Session already unusable.
    }

    session = null;
    rawCfSession = null;
    dinoSession = null;
    rawDinoSession = null;
    dinoProbe = null;
    sessionDevice = 'wasm';
    sessionPromise = null;
    initError = null;

    await ensureSession();
  })();

  return wasmFallbackPromise;
}

/**
 * @param {ImageBitmap} bitmap
 * @returns {Promise<number|null>} p(AI) from the DINOv2 probe, or null
 */
async function dinoScore(bitmap) {
  if (!dinoSession || !dinoProbe) return null;
  try {
    const chw = dinoPreprocessBitmap(bitmap);
    const input = new ort.Tensor('float32', chw, [1, 3, DINO_CROP_SIZE, DINO_CROP_SIZE]);
    const outputs = await dinoSession.run({ [DINO_INPUT_NAME]: input });
    return dinoScoreHiddenState(outputs.last_hidden_state, dinoProbe);
  } catch (err) {
    if (sessionDevice === 'webgpu' && (isWedgeError(err) || isWebGpuDeviceError(err))) {
      // Do not silently degrade to CF-only on a wedged backend: let the
      // caller run the WASM fallback and rescore with both heads.
      throw err;
    }
    console.debug('DINO head inference failed:', err?.message || err);
    return null;
  }
}

async function fetchImageBytes(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      credentials: 'omit',
      cache: 'force-cache',
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Image fetch failed (${res.status})`);
    }

    const type = res.headers.get('content-type') || '';
    if (type && !type.startsWith('image/')) {
      throw new Error(`Not an image content-type (${type})`);
    }

    return readResponseBytes(res, MAX_IMAGE_BYTES);
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('Image fetch timed out');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
    if (message.bufferB64.length > MAX_IMAGE_BASE64_CHARS) {
      throw new Error('Image exceeds size cap');
    }
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

/**
 * One neural pass (graphic gate + DINO + CF) on whatever backend is current.
 * @param {ArrayBuffer} bytes
 * @param {'adaptive'|'always'|'center'} mode
 * @returns {Promise<{ cfPAi: number, dinoPAi: number|null, graphicGate: boolean, agreementFallback: boolean }>}
 */
async function scoreImageOnce(bytes, mode) {
  const { session: activeSession } = await ensureSession();
  const mime = sniffMime(bytes);
  const blob = new Blob([bytes], { type: mime });
  const bitmap = await createImageBitmap(blob);
  try {
    const graphicGate = analyzeGraphicGate(bitmap).isGraphic;
    const dinoPAi = await dinoScore(bitmap);

    let cfPAi;
    let agreementFallback = false;
    if (mode === 'center') {
      const chw = await preprocessBitmap(bitmap);
      cfPAi = await predictCHW(activeSession, chw);
    } else {
      const views = await preprocessBitmapViews(bitmap);
      const effectiveMode = effectiveTtaMode(mode, dinoPAi);
      const viewed = await predictAdaptiveViews(activeSession, views, { mode: effectiveMode });
      cfPAi = viewed.neuralPAi;
      agreementFallback = viewed.agreementFallback === true;
    }

    return { cfPAi, dinoPAi, graphicGate, agreementFallback };
  } finally {
    bitmap.close();
  }
}

/**
 * Neural scoring with the runtime WebGPU escape hatch. If a run wedges past
 * MODEL_RUN_WEDGE_TIMEOUT_MS or throws a device-level WebGPU error, fall back
 * to WASM once and rescore this same image there. An error after the WASM
 * retry propagates to the caller so the badge gets its normal error state
 * instead of staying pending forever.
 * @param {ArrayBuffer} bytes
 * @param {'adaptive'|'always'|'center'} mode
 */
async function scoreImageWithFallback(bytes, mode) {
  if (sessionDevice === 'webgpu' && webGpuHealth.isUnhealthy()) {
    // Device loss reported between runs: rebuild before starting another
    // WebGPU run.
    await fallbackToWasm(webGpuHealth.reason());
  }

  try {
    return await scoreImageOnce(bytes, mode);
  } catch (err) {
    const fallBack = shouldFallBackToWasm({
      device: sessionDevice,
      error: err,
      alreadyFellBack: Boolean(wasmFallbackPromise),
    });
    if (!fallBack) throw err;
    await fallbackToWasm(err?.message || String(err));
    return scoreImageOnce(bytes, mode);
  }
}

async function classifyImage(rawBytes, url, customThreshold, ttaMode) {
  const bytes = toArrayBuffer(rawBytes);
  const heuristics = await analyzeHeuristics(bytes, url);
  const mode = normalizeTtaMode(ttaMode);
  const activeThreshold = customThreshold ?? threshold;

  let fused;
  let modelError = null;

  try {
    const { cfPAi, dinoPAi, graphicGate, agreementFallback } = await scoreImageWithFallback(
      bytes,
      mode
    );

    fused = fuseInferenceScores(cfPAi, dinoPAi, heuristics, activeThreshold, {
      graphicGate,
      agreementFallback,
    });
    if (graphicGate && cfPAi < DEFAULT_THRESHOLD) {
      fused.reasons.push('Flat graphic gate: DINO lift suppressed');
    }
  } catch (err) {
    modelError = err.message || String(err);
    if (heuristics.c2paAi || heuristics.metadataAi) {
      fused = fuseInferenceScores(0.5, null, heuristics, activeThreshold);
    } else {
      throw err;
    }
  }

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
        await ensureSession();
        const result = await runExclusiveAfterStart(
          inferLock,
          () =>
            classifyImage(
              bytes,
              message.url || '',
              message.threshold,
              message.ttaMode
            ),
          INFERENCE_TIMEOUT_MS,
          'Inference timed out'
        );
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

console.log('Clueside offscreen ready');

function sniffMime(bytes) {
  const buf = toArrayBuffer(bytes);
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0x89 && u8[1] === 0x50) return 'image/png';
  if (u8[0] === 0xff && u8[1] === 0xd8) return 'image/jpeg';
  if (u8[0] === 0x47 && u8[1] === 0x49) return 'image/gif';
  if (u8[8] === 0x57 && u8[9] === 0x45) return 'image/webp';
  return 'image/jpeg';
}
