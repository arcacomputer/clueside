import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldTryWebGpu } from '../src/community-forensics.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('shouldTryWebGpu', () => {
  it('returns false when adapter is null', () => {
    assert.equal(shouldTryWebGpu(null), false);
  });

  it('returns false when adapter is undefined', () => {
    assert.equal(shouldTryWebGpu(undefined), false);
  });

  it('returns true when adapter is present', () => {
    assert.equal(shouldTryWebGpu({}), true);
  });

  it('treats a missing adapter (Linux VM, some GPUs) as WASM-only', () => {
    assert.equal(shouldTryWebGpu(null), false);
    assert.equal(Boolean(null), false);
  });
});

describe('ORT logging', () => {
  it('suppresses warning-level ORT console output during session setup', async () => {
    const source = await readFile(join(ROOT, 'src/community-forensics.js'), 'utf8');
    assert.match(source, /ort\.env\.logLevel = 'error'/);
    assert.match(source, /logSeverityLevel: 3/);
  });
});
