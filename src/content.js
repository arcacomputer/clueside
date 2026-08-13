const MIN_SIZE = 96;
const seen = new WeakSet();
const badgeByEl = new WeakMap();
let enabled = true;
let autoScan = true;

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function parseSrcset(srcset) {
  if (!srcset) return [];
  return srcset
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
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

function ensureBadge(el) {
  let badge = badgeByEl.get(el);
  if (badge) return badge;

  badge = document.createElement('div');
  badge.className = 'haid-badge haid-pending';
  badge.textContent = '...';
  badge.setAttribute('role', 'status');
  badge.setAttribute('aria-live', 'polite');
  document.body.appendChild(badge);

  badgeByEl.set(el, badge);
  return badge;
}

function placeBadge(el, badge) {
  const rect = el.getBoundingClientRect();
  badge.style.position = 'fixed';
  badge.style.top = `${rect.top + 4}px`;
  badge.style.left = `${rect.left + 4}px`;
}

function renderBadge(el, result) {
  const badge = ensureBadge(el);
  placeBadge(el, badge);

  badge.classList.remove('haid-pending', 'haid-ai', 'haid-uncertain', 'haid-real', 'haid-skip', 'haid-error');

  if (result.skipped || result.error) {
    badge.classList.add('haid-skip');
    badge.textContent = result.error ? '?' : '-';
    badge.title = result.reason || result.error || 'Skipped';
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

async function analyzeHttpUrl(el, url, source) {
  const { width, height } = elementSize(el);
  const requestId = uid();

  const result = await chrome.runtime.sendMessage({
    type: 'analyze-url',
    requestId,
    url: new URL(url, location.href).href,
    width,
    height,
    source,
  });

  renderBadge(el, result);
}

async function analyzeBlobOrData(el, url, source) {
  const { width, height } = elementSize(el);

  try {
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    const requestId = uid();

    const result = await chrome.runtime.sendMessage({
      type: 'analyze-buffer',
      requestId,
      url,
      buffer,
      width,
      height,
      source,
    });

    renderBadge(el, result);
  } catch {
    renderBadge(el, {
      error: true,
      reason: 'Cannot read blob/data URL (cross-origin). No score shown.',
    });
  }
}

function queueImage(el, url, source) {
  if (!enabled || !autoScan || !url || seen.has(el)) return;
  if (!isVisible(el)) return;

  seen.add(el);

  if (url.startsWith('blob:') || url.startsWith('data:')) {
    analyzeBlobOrData(el, url, source);
    return;
  }

  if (/^https?:\/\//i.test(url)) {
    analyzeHttpUrl(el, url, source);
    return;
  }

  renderBadge(el, { skipped: true, reason: 'Unsupported URL scheme' });
}

function scanImg(el) {
  if (!(el instanceof HTMLImageElement)) return;

  const candidates = new Set();
  if (el.currentSrc) candidates.add(el.currentSrc);
  if (el.src) candidates.add(el.src);
  for (const u of parseSrcset(el.srcset)) candidates.add(u);

  const picture = el.closest('picture');
  if (picture) {
    for (const source of picture.querySelectorAll('source')) {
      if (source.src) candidates.add(source.src);
      for (const u of parseSrcset(source.srcset)) candidates.add(u);
    }
  }

  const url = [...candidates].find(Boolean);
  if (url) queueImage(el, url, 'img');
}

function scanBackground(el) {
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
  observer.observe(el);
}

const mutationObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node instanceof HTMLImageElement) {
        watch(node);
        scanImg(node);
      } else if (node instanceof Element) {
        watch(node);
        scanNode(node);
      }
    }

    if (mutation.type === 'attributes' && mutation.target instanceof HTMLImageElement) {
      seen.delete(mutation.target);
      scanImg(mutation.target);
    }
  }
});

async function bootstrap() {
  const settings = await chrome.runtime.sendMessage({ type: 'get-settings' });
  enabled = settings.enabled !== false;
  autoScan = settings.autoScan !== false;

  if (!enabled || !autoScan) return;

  document.querySelectorAll('img').forEach((img) => {
    watch(img);
    scanImg(img);
  });

  document.querySelectorAll('*').forEach((el) => {
    scanBackground(el);
    watch(el);
  });

  mutationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'style', 'class'],
  });

  chrome.runtime.sendMessage({ type: 'warmup' });

  window.addEventListener(
    'scroll',
    () => {
      for (const [el, badge] of badgeByEl.entries()) {
        if (document.contains(el)) placeBadge(el, badge);
      }
    },
    { passive: true }
  );

  window.addEventListener(
    'resize',
    () => {
      for (const [el, badge] of badgeByEl.entries()) {
        if (document.contains(el)) placeBadge(el, badge);
      }
    },
    { passive: true }
  );
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.enabled) enabled = changes.enabled.newValue !== false;
  if (changes.autoScan) autoScan = changes.autoScan.newValue !== false;
});

bootstrap();
