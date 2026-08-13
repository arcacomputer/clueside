import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('Chrome Web Store listing copy', () => {
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
});
