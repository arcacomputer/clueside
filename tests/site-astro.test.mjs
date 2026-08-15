import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFile(join(ROOT, path), 'utf8');
const readJson = async (path) => JSON.parse(await read(path));

describe('Astro website boundary', () => {
  it('keeps Astro and Wrangler dependencies scoped to site/', async () => {
    const [rootPackage, sitePackage] = await Promise.all([
      readJson('package.json'),
      readJson('site/package.json'),
    ]);

    assert.equal(rootPackage.devDependencies?.astro, undefined);
    assert.equal(rootPackage.devDependencies?.wrangler, undefined);
    assert.match(sitePackage.devDependencies.astro, /^\^7\./);
    assert.match(sitePackage.devDependencies.wrangler, /^\^4\./);
    assert.equal(sitePackage.dependencies?.['@astrojs/cloudflare'], undefined);
    assert.equal(sitePackage.devDependencies?.['@astrojs/cloudflare'], undefined);
    assert.equal(sitePackage.scripts.build, 'astro build');
    assert.match(rootPackage.scripts['site:build'], /--prefix site run build/);
    assert.match(rootPackage.scripts['site:check'], /--prefix site run check/);
  });

  it('builds a static Astro page with a layout and generated sitemap', async () => {
    const [config, page, layout] = await Promise.all([
      read('site/astro.config.mjs'),
      read('site/src/pages/index.astro'),
      read('site/src/layouts/BaseLayout.astro'),
    ]);

    assert.match(config, /site:\s*['"]https:\/\/clueside\.com['"]/);
    assert.match(config, /output:\s*['"]static['"]/);
    assert.match(config, /sitemap\(\)/);
    assert.match(page, /<BaseLayout/);
    assert.match(page, /The clues stay/);
    assert.match(layout, /<html lang="en">/);
    assert.match(layout, /<slot\s*\/>/);
  });

  it('targets Cloudflare Workers Static Assets and both production hostnames', async () => {
    const config = JSON.parse(await read('wrangler.jsonc'));
    assert.equal(config.name, 'clueside');
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    assert.equal(config.main, './site/worker.js');
    assert.equal(config.assets.directory, './site/dist');
    assert.equal(config.assets.binding, 'ASSETS');
    assert.equal(config.assets.run_worker_first, true);
    assert.equal(config.assets.not_found_handling, '404-page');
    assert.deepEqual(config.routes, [
      { pattern: 'clueside.com', custom_domain: true },
      { pattern: 'www.clueside.com', custom_domain: true },
    ]);
  });

  it('keeps extension packaging independent from site output', async () => {
    const packaging = await read('scripts/package.mjs');
    assert.doesNotMatch(packaging, /site\/dist/);
    assert.doesNotMatch(packaging, /site\/src/);
  });
});
