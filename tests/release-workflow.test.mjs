import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('GitHub Release workflow', () => {
  it('creates a release zip on v*.*.* tags', async () => {
    const yml = await readFile(join(ROOT, '.github/workflows/release.yml'), 'utf8');
    assert.match(yml, /v\*\.\*\.\*/);
    assert.match(yml, /npm ci/);
    assert.match(yml, /npm test/);
    assert.match(yml, /npm run fetch-model/);
    assert.match(yml, /npm run package/);
    assert.match(yml, /gh release create/);
    assert.match(yml, /GITHUB_TOKEN/);
    assert.doesNotMatch(yml, /npm publish/);
  });
});
