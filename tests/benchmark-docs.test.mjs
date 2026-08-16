import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// eval/benchmark-results.json is the single source of truth for published
// benchmark numbers. The site imports it directly and scripts/check-site.mjs
// validates the built site against it; these tests keep README.md and
// AGENTS.md from drifting. If they fail after a fresh harness run, update
// the JSON first, then the two documents.
const bench = JSON.parse(readFileSync(new URL('../eval/benchmark-results.json', import.meta.url), 'utf8'));
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const agents = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

describe('published benchmark numbers stay in sync', () => {
  it('README benchmark table carries the shipped-policy row from the JSON', () => {
    const row = new RegExp(
      `\\|\\s*${bench.bench.ba}%\\s*\\|\\s*${bench.bench.tpr}%\\s*\\|\\s*${bench.bench.tnr}%\\s*\\|`
    );
    assert.match(readme, row);
  });

  it('README reports the stress-set result from the JSON', () => {
    assert.ok(readme.includes(`${bench.stress.n}-image`));
    assert.ok(readme.includes(`${bench.stress.falsePositives} false positives`));
  });

  it('README keeps the legacy raw-max number and its not-shipped caveat', () => {
    assert.ok(readme.includes(`${bench.legacyRawMax.ba}%`));
    assert.match(readme, /legacy raw max/i);
  });

  it('AGENTS.md current-numbers line matches the JSON', () => {
    const line = new RegExp(
      `${bench.bench.ba}% BA, ${bench.bench.tpr}% TPR, ${bench.bench.tnr}% TNR`
    );
    assert.match(agents, line);
    assert.ok(agents.includes(`${bench.stress.n} `));
    assert.ok(agents.includes(`${bench.stress.falsePositives} FPs`));
  });

  it('bench composition is consistent inside the JSON', () => {
    assert.equal(bench.bench.ai + bench.bench.real, bench.bench.n);
  });

  it('JSON records the currently shipped extension version', () => {
    assert.equal(bench.extensionVersion, manifest.version);
  });
});
