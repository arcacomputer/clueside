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
    assert.match(yml, /npm run release:check-version -- "\$GITHUB_REF_NAME"/);
    assert.match(yml, /Verify release tag matches packaged version/);
    assert.match(yml, /npm test/);
    assert.match(yml, /npm run fetch-model/);
    assert.match(yml, /npm run package/);
    assert.match(yml, /gh release create/);
    assert.match(yml, /GITHUB_TOKEN/);
    assert.doesNotMatch(yml, /npm publish/);
  });

  it('ships project and third-party license notices in release builds', async () => {
    const build = await readFile(join(ROOT, 'scripts/build.mjs'), 'utf8');
    assert.match(build, /THIRD_PARTY_NOTICES\.md/);
    assert.match(build, /\['LICENSE', 'LICENSE'\]/);
    assert.match(build, /join\(ROOT, 'licenses'\)/);

    const notices = await readFile(join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    assert.match(notices, /CommunityForensics/);
    assert.match(notices, /DINOv2/);
    assert.match(notices, /ONNX Runtime Web/);
    assert.match(notices, /c2pa-web/);
    assert.match(notices, /exifr/);
  });
});
