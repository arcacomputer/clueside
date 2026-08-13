import { bytesToBase64 } from './bytes.js';
import {
  WALKTHROUGH_STORAGE_KEY,
  shouldShowWalkthrough,
} from './walkthrough.js';

const thresholdEl = document.getElementById('threshold');
const thresholdVal = document.getElementById('thresholdVal');
const enabledEl = document.getElementById('enabled');
const autoScanEl = document.getElementById('autoScan');
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const resultEl = document.getElementById('result');
const walkthroughEl = document.getElementById('walkthrough');
const walkthroughDismissEl = document.getElementById('walkthroughDismiss');

async function loadSettings() {
  const settings = await chrome.runtime.sendMessage({ type: 'get-settings' });
  const pct = Math.round((settings.threshold ?? 0.65) * 100);
  thresholdEl.value = String(pct);
  thresholdVal.textContent = `${pct}%`;
  enabledEl.checked = settings.enabled !== false;
  autoScanEl.checked = settings.autoScan !== false;
}

async function saveSettings(partial) {
  await chrome.runtime.sendMessage({ type: 'set-settings', settings: partial });
}

thresholdEl.addEventListener('input', () => {
  const pct = Number(thresholdEl.value);
  thresholdVal.textContent = `${pct}%`;
});

thresholdEl.addEventListener('change', () => {
  const pct = Number(thresholdEl.value);
  saveSettings({ threshold: pct / 100 });
});

enabledEl.addEventListener('change', () => {
  saveSettings({ enabled: enabledEl.checked });
});

autoScanEl.addEventListener('change', () => {
  saveSettings({ autoScan: autoScanEl.checked });
});

function formatResult(result) {
  if (!result || result.error) {
    return `Error: ${result?.error || 'Unknown error'}`;
  }

  const pct = Math.round((result.rawScore || 0) * 100);
  const neural = Math.round((result.neuralScore || 0) * 100);
  const verdictClass =
    result.verdict === 'ai'
      ? 'verdict-ai'
      : result.verdict === 'uncertain'
        ? 'verdict-uncertain'
        : 'verdict-real';

  const lines = [
    `<span class="${verdictClass}">Verdict: ${result.verdict.toUpperCase()} (${pct}% raw p(AI))</span>`,
    `Neural p(AI): ${neural}%`,
  ];

  if (result.generatorHint) {
    lines.push(`Possible generator hint: ${result.generatorHint} (not proof)`);
  }
  if (result.reasons?.length) {
    lines.push('', 'Signals:', ...result.reasons.map((r) => `- ${r}`));
  }

  return lines.join('\n');
}

async function analyzeFile(file) {
  resultEl.textContent = 'Analyzing...';
  const buffer = await file.arrayBuffer();
  const pct = Number(thresholdEl.value) / 100;

  const result = await chrome.runtime.sendMessage({
    type: 'analyze-buffer',
    requestId: `popup-${Date.now()}`,
    url: file.name,
    bufferB64: bytesToBase64(buffer),
    width: 256,
    height: 256,
    source: 'popup',
    threshold: pct,
  });

  resultEl.innerHTML = formatResult(result);
}

dropZone.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) analyzeFile(file);
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag');
});

dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag');
  const file = e.dataTransfer?.files?.[0];
  if (file && file.type.startsWith('image/')) analyzeFile(file);
});

loadSettings();
initWalkthrough();
chrome.runtime.sendMessage({ type: 'warmup' });

async function initWalkthrough() {
  const stored = await chrome.storage.local.get({ [WALKTHROUGH_STORAGE_KEY]: false });
  if (shouldShowWalkthrough(stored)) {
    walkthroughEl.hidden = false;
  }

  walkthroughDismissEl.addEventListener('click', async () => {
    walkthroughEl.hidden = true;
    await chrome.storage.local.set({ [WALKTHROUGH_STORAGE_KEY]: true });
  });
}
