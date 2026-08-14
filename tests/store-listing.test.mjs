import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('Chrome Web Store listing copy', () => {
  it('keeps package, manifest, and listing versions aligned', async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8'));
    const store = await readFile(join(ROOT, 'STORE.md'), 'utf8');

    assert.equal(manifest.version, pkg.version);
    assert.match(store, new RegExp(`\\*\\*Version:\\*\\* ${pkg.version.replaceAll('.', '\\.')}`));
    assert.match(store, new RegExp(`hybrid-ai-image-detector-${pkg.version.replaceAll('.', '\\.')}`));
  });

  it('keeps the short description at or under 132 characters', async () => {
    const store = await readFile(join(ROOT, 'STORE.md'), 'utf8');
    const match = store.match(
      /## Short description \(132 characters max\)\s+([^\n]+)/
    );
    assert.ok(match, 'STORE.md must include a short description heading');
    const short = match[1].trim();
    assert.ok(short.length > 20, 'short description is empty');
    assert.ok(
      short.length <= 132,
      `short description is ${short.length} characters (max 132): ${short}`
    );
    assert.equal(short.includes('\u2014'), false);
  });

  it('does not claim the item is already on the Web Store', async () => {
    const store = await readFile(join(ROOT, 'STORE.md'), 'utf8');
    assert.match(store, /not.*claimed to be on the Chrome Web Store/i);
    assert.doesNotMatch(store, /now available on the Chrome Web Store/i);
  });

  it('hosts a privacy policy page that forbids image upload', async () => {
    const html = await readFile(join(ROOT, 'docs/privacy.html'), 'utf8');
    assert.match(html, /Luis Felipe Abarca/);
    assert.match(html, /Image bytes are not uploaded/i);
    assert.match(html, /Hugging Face/);
    assert.equal(html.includes('\u2014'), false);
  });

  it('documents CF-primary fusion instead of the rejected raw max policy', async () => {
    const store = await readFile(join(ROOT, 'STORE.md'), 'utf8');
    assert.match(store, /CF-primary/);
    assert.doesNotMatch(store, /confidence is the max of the two raw sigmoids/i);
  });

  it('keeps the manifest permissions limited to APIs the code uses', async () => {
    const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.permissions, ['storage', 'offscreen', 'alarms']);
    assert.equal('web_accessible_resources' in manifest, false);
  });
});
