import { bytesToBase64 } from './bytes.js';
import {
  isTransientAnalyzeError,
  isFetchSkipError,
  withRetries,
  withAnalyzeDeadline,
  toSkipResult,
  FETCH_TIMEOUT_MS,
  AFTER_START_SAFETY_MS,
} from './analyze-retry.js';
import { createAnalyzeQueue } from './analyze-queue.js';
import { pickImageUrl } from './image-url.js';
import { readElementPixels, shouldTryElementPixels } from './element-pixels.js';
import { isAnalyzeJobCurrent } from './image-job.js';
import { MAX_IMAGE_BYTES, readResponseBytes } from './image-limits.js';

const MIN_SIZE = 96;
const seenGeneration = new WeakMap();
const badgeByEl = new Map();
const inFlight = new WeakSet();
const waitingForLoad = new WeakSet();
const watchedImageLoads = new WeakSet();
const seenUrl = new WeakMap();
let enabled = true;
let autoScan = true;
let scanGeneration = 0;
let observersReady = false;
let repositionRaf = 0;

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function collectBackgroundUrls(el) {
  const urls = [];
  const style = getComputedStyle(el);
  const bg = style.backgroundImage;
  if (!bg || bg === 'none') return urls;
  const matches = bg.matchAll(/url\(["']?([^"')]+)["']?\)/g);
  for (const m of matches) {
    if (m[1]) urls.push(m[1]);
  }
  return urls;
}

function elementSize(el) {
  const rect = el.getBoundingClientRect();
  return {
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  return true;
}

/**
 * Undo wraps from older builds. Never create a wrap; never replace img/picture.
 */
function unwrapLegacy(host) {
  const wrap = host?.parentElement;
  if (!wrap?.classList?.contains('haid-wrap')) return;
  const parent = wrap.parentElement;
  if (!parent) return;
  parent.insertBefore(host, wrap);
  wrap.remove();
}

function unwrapAllLegacy() {
  document.querySelectorAll('.haid-wrap').forEach((wrap) => {
    const host =
      wrap.querySelector(':scope > picture, :scope > img') || wrap.firstElementChild;
    if (host && wrap.parentElement) {
      wrap.parentElement.insertBefore(host, wrap);
    }
    wrap.remove();
  });
}

function overlayRoot() {
  return document.body || document.documentElement;
}

function ensureBadge(el) {
  if (el instanceof HTMLImageElement) {
    unwrapLegacy(el.closest('picture') || el);
  } else {
    unwrapLegacy(el);
  }

  let badge = badgeByEl.get(el);
  if (badge && document.contains(badge)) {
    placeBadge(el, badge);
    return badge;
  }
  if (badge) {
    badge.remove();
    badgeByEl.delete(el);
  }

  badge = document.createElement('div');
  badge.className = 'haid-badge haid-pending';
  badge.textContent = '...';
  badge.setAttribute('role', 'status');
  badge.setAttribute('aria-live', 'polite');
  overlayRoot().appendChild(badge);

  badgeByEl.set(el, badge);
  placeBadge(el, badge);
  return badge;
}

function placeBadge(el, badge) {
  if (!document.contains(el)) {
    badge.remove();
    badgeByEl.delete(el);
    return;
  }

  const rect = el.getBoundingClientRect();
  badge.style.position = 'fixed';
  badge.style.top = `${rect.top + 4}px`;
  badge.style.left = `${rect.left + 4}px`;
  badge.style.display = rect.width < 8 || rect.height < 8 ? 'none' : '';
}

function scheduleReposition() {
  if (repositionRaf) return;
  repositionRaf = requestAnimationFrame(() => {
    repositionRaf = 0;
    for (const [el, badge] of badgeByEl.entries()) {
      if (!document.contains(el) || !document.contains(badge)) {
        badge.remove();
        badgeByEl.delete(el);
        continue;
      }
      placeBadge(el, badge);
    }
  });
}

function clearAllBadges() {
  for (const badge of badgeByEl.values()) badge.remove();
  badgeByEl.clear();
}

function shortError(message) {
  if (!message) return 'Error';
  const cleaned = String(message).replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 16) return cleaned;
  return `${cleaned.slice(0, 13)}...`;
}

function renderBadge(el, result) {
  const badge = ensureBadge(el);
  placeBadge(el, badge);

  badge.classList.remove('haid-pending', 'haid-ai', 'haid-uncertain', 'haid-real', 'haid-skip', 'haid-error');

  if (!result) {
    result = { error: 'No response from extension' };
  }

  if (result.skipped || (result.error && isFetchSkipError(result.error))) {
    const reason = result.reason || result.error || 'Skipped';
    badge.classList.add('haid-skip');
    badge.textContent = 'skip';
    badge.title = reason;
    return;
  }

  if (result.error) {
    badge.classList.add('haid-error');
    badge.textContent = /inference/i.test(result.error) ? 'error' : shortError(result.error);
    badge.title = result.error;
    return;
  }

  const pct = Math.round((result.rawScore || 0) * 100);
  const verdict = result.verdict || 'uncertain';

  if (verdict === 'ai') {
    badge.classList.add('haid-ai');
    badge.textContent = `AI ${pct}%`;
  } else if (verdict === 'uncertain') {
    badge.classList.add('haid-uncertain');
    badge.textContent = `? ${pct}%`;
  } else {
    badge.classList.add('haid-real');
    badge.textContent = `OK ${pct}%`;
  }

  const lines = [
    `Raw p(AI): ${pct}%`,
    `Neural: ${Math.round((result.neuralScore || 0) * 100)}%`,
  ];
  if (result.generatorHint) {
    lines.push(`Possible generator hint: ${result.generatorHint} (not proof)`);
  }
  if (result.reasons?.length) {
    lines.push(...result.reasons);
  }
  badge.title = lines.join('\n');
}

function markFinal(el, url) {
  seenGeneration.set(el, scanGeneration);
  seenUrl.set(el, url);
}

function forgetResult(el) {
  seenGeneration.delete(el);
  seenUrl.delete(el);
}

function finalizeResult(el, result, url) {
  if (result?.error && isFetchSkipError(result.error)) {
    renderBadge(el, toSkipResult(result.error));
    markFinal(el, url);
    return;
  }

  renderBadge(el, result);
  if (!result?.error || !isTransientAnalyzeError(result.error)) {
    markFinal(el, url);
  }
}

async function analyzeHttpUrl(el, url, source, ttaMode) {
  const { width, height } = elementSize(el);
  ensureBadge(el);

  return withAnalyzeDeadline(
    () =>
      withRetries(async () => {
        const response = await chrome.runtime.sendMessage({
          type: 'analyze-url',
          requestId: uid(),
          url: new URL(url, location.href).href,
          width,
          height,
          source,
          ttaMode,
        });
        return response || { error: 'No response from extension' };
      }),
    { timeoutMs: AFTER_START_SAFETY_MS, timeoutMessage: 'Inference timed out' }
  );
}

async function fetchBlobOrData(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Image fetch failed (${res.status})`);
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

async function sendBuffer(el, url, source, ttaMode, buffer) {
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    return { skipped: true, reason: 'Image exceeds size cap' };
  }
  const { width, height } = elementSize(el);
  const bufferB64 = bytesToBase64(buffer);

  return withAnalyzeDeadline(
    () =>
      withRetries(async () => {
        const response = await chrome.runtime.sendMessage({
          type: 'analyze-buffer',
          requestId: uid(),
          url,
          bufferB64,
          width,
          height,
          source,
          ttaMode,
        });
        return response || { error: 'No response from extension' };
      }),
    { timeoutMs: AFTER_START_SAFETY_MS, timeoutMessage: 'Inference timed out' }
  );
}

async function analyzeBlobOrData(el, url, source, ttaMode) {
  ensureBadge(el);

  try {
    const buffer = await fetchBlobOrData(url);
    return await sendBuffer(el, url, source, ttaMode, buffer);
  } catch (err) {
    const message = err?.message || 'Cannot read blob/data URL';
    if (isFetchSkipError(message)) {
      return toSkipResult(message);
    }
    return { error: message };
  }
}

/**
 * Rescue path: original bytes were unreachable (file:// gallery,
 * offline re-fetch, credentialed CDN) but the browser already decoded
 * the pixels. Re-encode them losslessly and score neural-only.
 * Returns null when pixels are unreadable (tainted canvas) so the
 * caller keeps the original skip result.
 */
async function analyzeElementPixels(el, url, source, ttaMode) {
  if (!(el instanceof HTMLImageElement)) return null;

  try {
    const buffer = await readElementPixels(el);
    const result = await sendBuffer(el, url, source, ttaMode, buffer);
    if (result && !result.error && !result.skipped) {
      return result;
    }
    return null;
  } catch {
    return null;
  }
}

function isCurrentAnalyzeJob(job) {
  const { el, source } = job;
  return isAnalyzeJobCurrent(job, {
    enabled,
    autoScan,
    connected: document.contains(el),
    generation: scanGeneration,
    currentUrl: source === 'img' ? pickImageUrl(el) : '',
    backgroundUrls: source === 'background' ? collectBackgroundUrls(el) : [],
  });
}

function rescanJobTarget({ el, source }) {
  if (!enabled || !autoScan || !document.contains(el)) return;
  if (source === 'img') scanImg(el);
  else scanBackground(el);
}

async function runAnalyzeJob(job, { ttaMode }) {
  const { el, url, source } = job;
  if (!isCurrentAnalyzeJob(job)) return { stale: true };

  let result;

  if (url.startsWith('blob:') || url.startsWith('data:')) {
    result = await analyzeBlobOrData(el, url, source, ttaMode);
  } else if (/^https?:\/\//i.test(url)) {
    result = await analyzeHttpUrl(el, url, source, ttaMode);
  } else {
    // file:// and other schemes: bytes are not fetchable, but the
    // rendered element still has pixels we can read below.
    result = { skipped: true, reason: 'Unsupported URL scheme' };
  }

  if (shouldTryElementPixels(result, isFetchSkipError)) {
    const rescued = await analyzeElementPixels(el, url, source, ttaMode);
    if (rescued) result = rescued;
  }

  if (!isCurrentAnalyzeJob(job)) return { stale: true };

  finalizeResult(el, result, url);
  return { stale: false };
}

const analyzeQueue = createAnalyzeQueue({
  run: runAnalyzeJob,
});

function queueImage(el, url, source) {
  if (!enabled || !autoScan || !url) return;
  if (!document.contains(el)) return;
  if (inFlight.has(el)) return;
  if (seenGeneration.get(el) === scanGeneration && seenUrl.get(el) === url) return;
  if (!isVisible(el)) return;

  const job = { el, url, source, generation: scanGeneration };
  let stale = false;
  inFlight.add(el);
  ensureBadge(el);

  analyzeQueue
    .enqueue(job)
    .then((outcome) => {
      stale = outcome?.stale === true;
    })
    .catch((err) => {
      if (isCurrentAnalyzeJob(job)) {
        finalizeResult(el, { error: err?.message || String(err) }, url);
      } else {
        stale = true;
      }
    })
    .finally(() => {
      inFlight.delete(el);
      if (stale) rescanJobTarget(job);
    });
}

function scanImg(el) {
  if (!(el instanceof HTMLImageElement)) return;
  if (!enabled || !autoScan) return;

  unwrapLegacy(el.closest('picture') || el);

  const url = pickImageUrl(el);
  if (!url) {
    if (!waitingForLoad.has(el)) {
      waitingForLoad.add(el);
      el.addEventListener(
        'load',
        () => {
          waitingForLoad.delete(el);
          scanImg(el);
        },
        { once: true }
      );
    }
    return;
  }

  queueImage(el, url, 'img');
}

function scanBackground(el) {
  if (!enabled || !autoScan) return;
  if (el.classList?.contains('haid-badge') || el.classList?.contains('haid-wrap')) return;
  for (const url of collectBackgroundUrls(el)) {
    queueImage(el, url, 'background');
  }
}

function scanNode(node) {
  if (node instanceof HTMLImageElement) {
    scanImg(node);
    return;
  }

  if (node instanceof Element) {
    if (node.querySelectorAll) {
      node.querySelectorAll('img').forEach((img) => {
        watch(img);
        scanImg(img);
      });
    }
    scanBackground(node);
    if (node !== document.body) {
      for (const child of node.querySelectorAll('*')) {
        watch(child);
        scanBackground(child);
      }
    }
  }
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      if (el instanceof HTMLImageElement) scanImg(el);
      else scanBackground(el);
    }
  },
  { rootMargin: '100px', threshold: 0.01 }
);

function watch(el) {
  if (!(el instanceof Element)) return;
  if (el.classList?.contains('haid-badge')) return;

  if (el instanceof HTMLImageElement && !watchedImageLoads.has(el)) {
    watchedImageLoads.add(el);
    el.addEventListener('load', () => {
      const currentUrl = pickImageUrl(el);
      if (!currentUrl || seenUrl.get(el) === currentUrl) return;
      forgetResult(el);
      scanImg(el);
      scheduleReposition();
    });
  }

  observer.observe(el);
}

const mutationObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node instanceof HTMLImageElement) {
        watch(node);
        scanImg(node);
      } else if (node instanceof Element) {
        if (node.classList?.contains('haid-badge')) continue;
        if (node.classList?.contains('haid-wrap')) {
          unwrapLegacy(node.querySelector('img, picture') || node.firstElementChild);
          continue;
        }
        watch(node);
        scanNode(node);
      }
    }

    if (mutation.type === 'attributes' && mutation.target instanceof HTMLImageElement) {
      forgetResult(mutation.target);
      scanImg(mutation.target);
    } else if (mutation.type === 'attributes' && mutation.target instanceof HTMLSourceElement) {
      const img = mutation.target.closest('picture')?.querySelector('img');
      if (img) {
        forgetResult(img);
        scanImg(img);
      }
    } else if (mutation.type === 'attributes' && mutation.target instanceof Element) {
      forgetResult(mutation.target);
      scanBackground(mutation.target);
    }
  }
  scheduleReposition();
});

function rescanAll() {
  scanGeneration += 1;
  unwrapAllLegacy();
  document.querySelectorAll('img').forEach(scanImg);
  document.querySelectorAll('*').forEach(scanBackground);
}

function attachObservers() {
  if (observersReady) return;
  observersReady = true;

  unwrapAllLegacy();
  document.querySelectorAll('img').forEach(watch);
  document.querySelectorAll('*').forEach(watch);

  mutationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'sizes', 'media', 'style', 'class'],
  });

  window.addEventListener('scroll', scheduleReposition, { capture: true, passive: true });
  window.addEventListener('resize', scheduleReposition, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('scroll', scheduleReposition, { passive: true });
    window.visualViewport.addEventListener('resize', scheduleReposition, { passive: true });
  }
}

async function bootstrap() {
  const settings = await chrome.runtime.sendMessage({ type: 'get-settings' });
  enabled = settings.enabled !== false;
  autoScan = settings.autoScan !== false;

  attachObservers();

  if (enabled && autoScan) {
    await chrome.runtime.sendMessage({ type: 'warmup' });
    rescanAll();
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;

  const wasEnabled = enabled;
  const wasAutoScan = autoScan;

  if (changes.enabled) enabled = changes.enabled.newValue !== false;
  if (changes.autoScan) autoScan = changes.autoScan.newValue !== false;

  if (!enabled || !autoScan) {
    scanGeneration += 1;
    clearAllBadges();
    return;
  }

  if ((!wasEnabled && enabled) || (!wasAutoScan && autoScan)) {
    chrome.runtime.sendMessage({ type: 'warmup' }).then(() => rescanAll());
    return;
  }

  if (changes.threshold) {
    rescanAll();
  }
});

bootstrap();
