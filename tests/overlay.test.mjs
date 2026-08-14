import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('overlay badges do not wrap images', () => {
  it('never replaceWith img or picture, and uses position:fixed', async () => {
    const content = await readFile(join(ROOT, 'src/content.js'), 'utf8');
    assert.doesNotMatch(content, /replaceWith\(/);
    assert.doesNotMatch(content, /function ensureWrap/);
    assert.doesNotMatch(content, /className = 'haid-wrap'/);
    assert.match(content, /position = 'fixed'/);
    assert.match(content, /pickImageUrl/);
    assert.match(content, /createAnalyzeQueue/);
    assert.match(content, /AFTER_START_SAFETY_MS/);
    assert.match(content, /FETCH_TIMEOUT_MS/);
    assert.match(content, /ttaMode/);
    assert.doesNotMatch(content, /ANALYZE_TIMEOUT_MS/);
    assert.doesNotMatch(content, /timeoutMessage: 'Timed out'/);
    assert.match(content, /scheduleReposition/);
    assert.match(content, /badgeByEl = new Map\(\)/);
    assert.doesNotMatch(content, /badgeByEl = new WeakMap\(\)/);
    assert.match(content, /badgeByEl\.entries\(\)/);
    assert.match(content, /visualViewport/);
    assert.equal(content.includes('\u2014'), false);
  });

  it('reposition walks live badge pairs and drops stale entries', async () => {
    const content = await readFile(join(ROOT, 'src/content.js'), 'utf8');
    assert.match(content, /for \(const \[el, badge\] of badgeByEl\.entries\(\)/);
    assert.match(content, /badgeByEl\.delete\(el\)/);
    assert.match(content, /scheduleReposition\(\);\s*\}\);/s);
  });

  it('does not start the fetch clock when the badge is painted', async () => {
    const content = await readFile(join(ROOT, 'src/content.js'), 'utf8');
    assert.match(content, /inFlight.add\(el\);\s*ensureBadge\(el\);\s*analyzeQueue/s);
  });

  it('does not paint stale lazy-image results and clears badges when disabled', async () => {
    const content = await readFile(join(ROOT, 'src/content.js'), 'utf8');
    assert.match(content, /isCurrentAnalyzeJob\(job\)/);
    assert.match(content, /return \{ stale: true \}/);
    assert.match(content, /clearAllBadges\(\)/);
    assert.match(content, /changes\.threshold/);
    assert.match(content, /HTMLSourceElement/);
  });

  it('defers a rescan when another background layer is added in flight', async () => {
    const content = await readFile(join(ROOT, 'src/content.js'), 'utf8');
    assert.match(content, /deferredRescan\.add\(el\)/);
    assert.match(content, /deferredRescan\.delete\(el\)/);
    assert.match(content, /if \(rescanWasDeferred\)[\s\S]*scanImg\(el\);[\s\S]*scanBackground\(el\);/);
    assert.match(content, /unseenBackgroundUrls/);
  });

  it('does not style a wrapping host around photos', async () => {
    const css = await readFile(join(ROOT, 'src/overlay.css'), 'utf8');
    assert.doesNotMatch(css, /\.haid-wrap/);
    assert.match(css, /position:\s*fixed/);
  });
});

describe('analyze clocks are split', () => {
  it('offscreen times fetch and inference separately and serializes ORT', async () => {
    const offscreen = await readFile(join(ROOT, 'src/offscreen.js'), 'utf8');
    assert.match(offscreen, /FETCH_TIMEOUT_MS/);
    assert.match(offscreen, /INFERENCE_TIMEOUT_MS/);
    assert.match(offscreen, /runExclusiveAfterStart/);
    assert.match(offscreen, /preprocessBitmap/);
    assert.match(offscreen, /ttaMode/);
    assert.match(offscreen, /Image fetch timed out/);
    assert.match(offscreen, /Inference timed out/);
    assert.match(offscreen, /analyzeGraphicGate/);
    assert.match(offscreen, /fuseInferenceScores/);
    assert.equal(offscreen.includes('\u2014'), false);
  });

  it('background forwards ttaMode to offscreen', async () => {
    const background = await readFile(join(ROOT, 'src/background.js'), 'utf8');
    assert.match(background, /ttaMode/);
    assert.match(background, /ttaMode: message.ttaMode/);
  });
});

describe('release zip layout', () => {
  it('stores package files relative to dist so manifest.json is at the zip root', async () => {
    const pkg = await readFile(join(ROOT, 'scripts/package.mjs'), 'utf8');
    assert.match(pkg, /toPosix\(relative\(DIST, abs\)\)/);
    assert.match(pkg, /localeCompare/);
    assert.match(pkg, /temporary model download/);
    assert.doesNotMatch(pkg, /join\(['"]hybrid-ai-image-detector['"]/);
  });
});

describe('portable install copy', () => {
  it('documents chrome://extensions without OS-specific paths', async () => {
    const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
    assert.match(readme, /chrome:\/\/extensions/);
    assert.match(readme, /manifest\.json/);
    assert.match(readme, /Load unpacked/);
    assert.doesNotMatch(readme, /\/Applications\//);
    assert.doesNotMatch(readme, /C:\\\\Users/);
    assert.doesNotMatch(readme, /AppData/);
    assert.doesNotMatch(readme, /within about 8 seconds/);
    assert.match(readme, /tens of seconds/);
    assert.equal(readme.includes('\u2014'), false);
  });
});
