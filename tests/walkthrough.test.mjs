import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WALKTHROUGH_STORAGE_KEY,
  WALKTHROUGH_STEPS,
  WALKTHROUGH_DROP_HINT,
  WALKTHROUGH_DISMISS_LABEL,
  shouldShowWalkthrough,
} from '../src/walkthrough.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('first-run walkthrough', () => {
  it('shows until dismissed, then never again', () => {
    assert.equal(shouldShowWalkthrough({}), true);
    assert.equal(shouldShowWalkthrough({ [WALKTHROUGH_STORAGE_KEY]: false }), true);
    assert.equal(shouldShowWalkthrough({ [WALKTHROUGH_STORAGE_KEY]: true }), false);
  });

  it('has three steps: pin, reload, wait for AI/OK badges', () => {
    assert.equal(WALKTHROUGH_STEPS.length, 3);
    assert.match(WALKTHROUGH_STEPS[0], /pin the toolbar icon/i);
    assert.match(WALKTHROUGH_STEPS[1], /reload the page/i);
    assert.match(WALKTHROUGH_STEPS[2], /AI/);
    assert.match(WALKTHROUGH_STEPS[2], /OK/);
  });

  it('mentions the drop zone as optional', () => {
    assert.match(WALKTHROUGH_DROP_HINT, /optional/i);
    assert.match(WALKTHROUGH_DROP_HINT, /drop/i);
  });
});

describe('popup markup', () => {
  it('includes the walkthrough card and keeps existing controls', async () => {
    const html = await readFile(join(ROOT, 'src/popup.html'), 'utf8');
    assert.match(html, /id="walkthrough"/);
    assert.match(html, /id="walkthroughDismiss"/);
    assert.match(html, new RegExp(WALKTHROUGH_DISMISS_LABEL));
    for (const step of WALKTHROUGH_STEPS) {
      assert.ok(html.includes(step), `missing step: ${step}`);
    }
    assert.ok(html.includes(WALKTHROUGH_DROP_HINT));
    assert.match(html, /id="autoScan"/);
    assert.match(html, /id="enabled"/);
    assert.match(html, /id="threshold"/);
    assert.match(html, /id="dropZone"/);
    assert.equal(html.includes('\u2014'), false);
  });

  it('persists dismiss in chrome.storage.local', async () => {
    const js = await readFile(join(ROOT, 'src/popup.js'), 'utf8');
    assert.match(js, /chrome\.storage\.local/);
    assert.match(js, /WALKTHROUGH_STORAGE_KEY/);
    assert.match(js, /walkthroughDismissed|WALKTHROUGH_STORAGE_KEY/);
  });
});

describe('README how to use', () => {
  it('leads with the three steps before Load unpacked', async () => {
    const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
    const howTo = readme.indexOf('## How to use');
    const install = readme.indexOf('Load unpacked');
    assert.ok(howTo >= 0, 'README needs a How to use section');
    assert.ok(install > howTo, 'How to use should appear before Load unpacked');
    assert.match(readme, /Pin the toolbar icon/);
    assert.match(readme, /Reload the page you are on/);
    assert.match(readme, /AI/);
    assert.match(readme, /OK/);
    assert.equal(readme.includes('\u2014'), false);
  });
});
