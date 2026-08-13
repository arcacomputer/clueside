import { bytesToBase64 } from './bytes.js';
import {
  isTransientAnalyzeError,
  isFetchSkipError,
  withRetries,
  withAnalyzeDeadline,
  toSkipResult,
  ANALYZE_TIMEOUT_MS,
} from './analyze-retry.js';
import { pickImageUrl } from './image-url.js';

const MIN_SIZE = 96;
const seenGeneration = new WeakMap();
const badgeByEl = new WeakMap();
const inFlight = new WeakSet();
const waitingForLoad = new WeakSet();
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
  if (badge) badge.remove();

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
        continue;
      }
      placeBadge(el, badge);
    }
  });
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
    badge.classList.add('haid-uncertain');
    badge.textContent = shortError(result.error);
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

function markFinal(el) {
  seenGeneration.set(el, scanGeneration);
}

function finalizeResult(el, result) {
  if (result?.error && isFetchSkipError(result.error)) {
    renderBadge(el, toSkipResult(result.error));
    markFinal(el);
    return;
  }

  renderBadge(el, result);
  if (!result?.error || !isTransientAnalyzeError(result.error)) {
    markFinal(el);
  }
}

async function analyzeHttpUrl(el, url, source) {
  const { width, height } = elementSize(el);
  ensureBadge(el);

  const result = await withAnalyzeDeadline(
    () =>
      withRetries(async () => {
        const response = await chrome.runtime.sendMessage({
          type: 'analyze-url',
          requestId: uid(),
          url: new URL(url, location.href).href,
          width,
          height,
          source,
        });
        return response || { error: 'No response from extension' };
      }),
    { timeoutMs: ANALYZE_TIMEOUT_MS, timeoutMessage: 'Timed out' }
  );

  finalizeResult(el, result);
}

async function analyzeBlobOrData(el, url, source) {
  const { width, height } = elementSize(el);
  ensureBadge(el);

  try {
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    const bufferB64 = bytesToBase64(buffer);

    const result = await withAnalyzeDeadline(
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
          });
          return response || { error: 'No response from extension' };
        }),
      { timeoutMs: ANALYZE_TIMEOUT_MS, timeoutMessage: 'Timed out' }
    );

    finalizeResult(el, result);
  } catch (err) {
    renderBadge(el, toSkipResult(err?.message || 'Cannot read blob/data URL'));
    markFinal(el);
  }
}

function queueImage(el, url, source) {
  if (!enabled || !autoScan || !url) return;
  if (inFlight.has(el)) return;
  if (seenGeneration.get(el) === scanGeneration) return;
  if (!isVisible(el)) return;

  inFlight.add(el);

  const run = async () => {
    try {
      if (url.startsWith('blob:') || url.startsWith('data:')) {
        await analyzeBlobOrData(el, url, source);
        return;
      }

      if (/^https?:\/\//i.test(url)) {
        await analyzeHttpUrl(el, url, source);
        return;
      }

      renderBadge(el, { skipped: true, reason: 'Unsupported URL scheme' });
      markFinal(el);
    } finally {
      inFlight.delete(el);
    }
  };

  run();
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
      node.querySelectorAll('img').forEach(scanImg);
    }
    scanBackground(node);
    if (node !== document.body) {
      for (const child of node.querySelectorAll('*')) {
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
      seenGeneration.delete(mutation.target);
      scanImg(mutation.target);
    }
  }
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
    attributeFilter: ['src', 'srcset', 'style', 'class'],
  });

  window.addEventListener('scroll', scheduleReposition, { capture: true, passive: true });
  window.addEventListener('resize', scheduleReposition, { passive: true });
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

  if ((!wasEnabled && enabled) || (!wasAutoScan && autoScan)) {
    if (enabled && autoScan) {
      chrome.runtime.sendMessage({ type: 'warmup' }).then(() => rescanAll());
    }
  }
});

bootstrap();
