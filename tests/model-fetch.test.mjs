import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODEL_SPECS,
  buildModelManifest,
  modelFileUrl,
} from '../scripts/model-specs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

describe('pinned model fetch inputs', () => {
  it('pins immutable revisions, byte lengths, and SHA-256 for every asset', () => {
    assert.equal(MODEL_SPECS.length, 2);
    for (const model of MODEL_SPECS) {
      assert.match(model.revision, /^[a-f0-9]{40}$/);
      for (const file of model.files) {
        assert.ok(file.bytes > 0);
        assert.match(file.sha256, /^[a-f0-9]{64}$/);
        const url = modelFileUrl(model, file);
        assert.ok(url.includes(`/resolve/${model.revision}/`));
        assert.equal(url.includes('/resolve/main/'), false);
      }
    }
  });

  it('keeps tracked configs and manifests aligned with the pinned specs', async () => {
    for (const model of MODEL_SPECS) {
      for (const file of model.files.filter((entry) => !entry.path.endsWith('.onnx'))) {
        assert.equal(await sha256(join(ROOT, 'models', model.repo, file.path)), file.sha256);
      }
      const manifest = JSON.parse(
        await readFile(join(ROOT, 'models', model.repo, 'manifest.json'), 'utf8')
      );
      assert.deepEqual(manifest, buildModelManifest(model));
    }
  });

  it('verifies local ONNX files when the optional weights are present', async () => {
    for (const model of MODEL_SPECS) {
      const file = model.files.find((entry) => entry.path.endsWith('.onnx'));
      const path = join(ROOT, 'models', model.repo, file.path);
      if (await exists(path)) assert.equal(await sha256(path), file.sha256);
    }
  });
});
