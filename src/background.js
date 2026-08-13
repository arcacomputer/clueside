const OFFSCREEN_URL = 'offscreen.html';
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MIN_DIMENSION = 96;

let offscreenCreating = null;
const pendingByTab = new Map();

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

async function ensureOffscreen() {
  if (await hasOffscreenDocument()) return;

  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }

  offscreenCreating = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['WORKERS'],
    justification: 'Run ONNX image classification with WebGPU or WASM',
  });

  await offscreenCreating;
  offscreenCreating = null;

  const settings = await getSettings();
  await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'init',
    threshold: settings.threshold,
  });
}

async function sendToOffscreen(payload) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: 'offscreen', ...payload });
}

function isHttpUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

async function fetchImageBytes(url) {
  const res = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
  if (!res.ok) {
    throw new Error(`Fetch failed (${res.status})`);
  }

  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) {
    throw new Error('Not an image content-type');
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

async function analyzeRequest({ requestId, tabId, url, buffer, width, height, source, threshold: customThreshold }) {
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
      buffer,
      url,
      threshold,
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
      try {
        const buffer = await fetchImageBytes(message.url);
        const result = await analyzeRequest({
          requestId: message.requestId,
          tabId,
          url: message.url,
          buffer,
          width: message.width,
          height: message.height,
          source: message.source,
        });
        sendResponse(result);
      } catch (err) {
        sendResponse({
          requestId: message.requestId,
          tabId,
          url: message.url,
          error: err.message || String(err),
        });
      }
      return;
    }

    if (message.type === 'analyze-buffer') {
      const tabId = sender.tab?.id;
      const result = await analyzeRequest({
        requestId: message.requestId,
        tabId,
        url: message.url,
        buffer: message.buffer,
        width: message.width,
        height: message.height,
        source: message.source,
        threshold: message.threshold,
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
