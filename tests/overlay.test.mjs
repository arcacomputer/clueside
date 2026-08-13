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
    assert.match(content, /ANALYZE_TIMEOUT_MS/);
    assert.match(content, /scheduleReposition/);
    assert.equal(content.includes('\u2014'), false);
  });

  it('does not style a wrapping host around photos', async () => {
    const css = await readFile(join(ROOT, 'src/overlay.css'), 'utf8');
    assert.doesNotMatch(css, /\.haid-wrap/);
    assert.match(css, /position:\s*fixed/);
  });
});

describe('release zip layout', () => {
  it('stores package files relative to dist so manifest.json is at the zip root', async () => {
    const pkg = await readFile(join(ROOT, 'scripts/package.mjs'), 'utf8');
    assert.match(pkg, /toPosix\(relative\(DIST, abs\)\)/);
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
    assert.equal(readme.includes('\u2014'), false);
  });
});
