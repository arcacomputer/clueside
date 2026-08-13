const OFFSCREEN_URL = 'offscreen.html';
const MIN_DIMENSION = 96;

let offscreenCreating = null;
let offscreenReadyPromise = null;
const pendingByTab = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getSettings() {
  const stored = await chrome.storage.sync.get({
    enabled: true,
    threshold: 0.65,
    autoScan: true,
  });
  return stored;
}

async function hasOffscreenDocument() {
  if (!chrome.offscreen?.hasDocument) return false;
  return chrome.offscreen.hasDocument();
}

async function pingOffscreen() {
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ping' });
  return Boolean(res?.ok);
}

async function waitForOffscreenListener() {
  let lastError = 'Offscreen listener not ready';
  for (let i = 0; i < 50; i++) {
    try {
      if (await pingOffscreen()) return;
    } catch (err) {
      lastError = err.message || String(err);
    }
    await sleep(100);
  }
  throw new Error(lastError);
}

async function createOffscreenDocument() {
  if (await hasOffscreenDocument()) return;

  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }

  offscreenCreating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ['WORKERS'],
      justification: 'Run ONNX image classification with WebGPU or WASM',
    })
    .catch((err) => {
      const msg = err.message || String(err);
      if (msg.includes('single offscreen')) return;
      throw err;
    });

  try {
    await offscreenCreating;
  } finally {
    offscreenCreating = null;
  }
}

/**
 * Wait until the offscreen document exists, its message listener is
 * registered (the onnxruntime bundle has evaluated), and ensureSession
 * has finished. Analyzes must not run before this resolves.
 */
async function ensureOffscreen() {
  if (offscreenReadyPromise) {
    await offscreenReadyPromise;
    return;
  }

  offscreenReadyPromise = (async () => {
    await createOffscreenDocument();
    await waitForOffscreenListener();

    const settings = await getSettings();
    const init = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'init',
      threshold: settings.threshold,
    });
    if (!init?.ok) {
      throw new Error(init?.error || 'Offscreen init failed');
    }
  })();

  try {
    await offscreenReadyPromise;
  } catch (err) {
    offscreenReadyPromise = null;
    throw err;
  }
}

async function sendToOffscreen(payload) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: 'offscreen', ...payload });
}

function isHttpUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

/**
 * Image bytes never travel through this service worker. sendMessage
 * JSON-serializes payloads, so ArrayBuffers arrive as undefined on the
 * other side. The offscreen document fetches http(s) URLs itself;
 * blob/data and file-drop payloads arrive here already base64-encoded
 * and are forwarded as strings.
 */
async function analyzeRequest({ requestId, tabId, url, bufferB64, width, height, source, threshold: customThreshold, ttaMode }) {
  const settings = await getSettings();
  if (!settings.enabled) {
    return { skipped: true, reason: 'Extension disabled' };
  }

  if ((width && width < MIN_DIMENSION) || (height && height < MIN_DIMENSION)) {
    return { skipped: true, reason: 'Image too small' };
  }

  const threshold = typeof customThreshold === 'number' ? customThreshold : settings.threshold;

  try {
    const response = await sendToOffscreen({
      type: 'analyze',
      bufferB64,
      url,
      threshold,
      ttaMode,
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Offscreen analysis failed');
    }

    return { requestId, tabId, url, source, ...response.result };
  } catch (err) {
    return {
      requestId,
      tabId,
      url,
      source,
      error: err.message || String(err),
    };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === 'analyze-url') {
      const tabId = sender.tab?.id;
      if (!isHttpUrl(message.url)) {
        sendResponse({
          requestId: message.requestId,
          tabId,
          url: message.url,
          error: 'Unsupported URL scheme for URL analysis',
        });
        return;
      }
      const result = await analyzeRequest({
        requestId: message.requestId,
        tabId,
        url: message.url,
        width: message.width,
        height: message.height,
        source: message.source,
        ttaMode: message.ttaMode,
      });
      sendResponse(result);
      return;
    }

    if (message.type === 'analyze-buffer') {
      const tabId = sender.tab?.id;
      if (typeof message.bufferB64 !== 'string' || message.bufferB64.length === 0) {
        sendResponse({
          requestId: message.requestId,
          tabId,
          url: message.url,
          error: 'Missing image payload (expected base64 bytes)',
        });
        return;
      }
      const result = await analyzeRequest({
        requestId: message.requestId,
        tabId,
        url: message.url,
        bufferB64: message.bufferB64,
        width: message.width,
        height: message.height,
        source: message.source,
        threshold: message.threshold,
        ttaMode: message.ttaMode,
      });
      sendResponse(result);
      return;
    }

    if (message.type === 'get-settings') {
      sendResponse(await getSettings());
      return;
    }

    if (message.type === 'set-settings') {
      await chrome.storage.sync.set(message.settings);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'warmup') {
      try {
        await ensureOffscreen();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return;
    }
  })();

  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await ensureOffscreen();
  } catch {
    // Model may not be present until fetch-model runs.
  }
});

export {};
