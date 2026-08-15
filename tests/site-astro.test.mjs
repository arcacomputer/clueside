import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFile(join(ROOT, path), 'utf8');
const readBinary = (path) => readFile(join(ROOT, path));
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

  it('deploys site versions without resyncing already-configured custom domains', async () => {
    const workflow = await read('.github/workflows/deploy-site.yml');
    assert.match(workflow, /wrangler versions upload/);
    assert.match(workflow, /wrangler versions deploy/);
    assert.match(workflow, /--version-tag/);
    assert.doesNotMatch(workflow, /wrangler deploy --config/);
    assert.match(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
    assert.match(workflow, /secrets\.CLOUDFLARE_ACCOUNT_ID/);

    const rootPackage = JSON.parse(await read('package.json'));
    assert.equal(rootPackage.scripts['site:deploy'], 'node scripts/deploy-site.mjs');
    const deployScript = await read('scripts/deploy-site.mjs');
    assert.match(deployScript, /versions', 'upload/);
    assert.match(deployScript, /versions',\s*'deploy/);
    assert.doesNotMatch(deployScript, /CLOUDFLARE_API_TOKEN\s*=/);
  });

  it('ships complete Open Graph and X card metadata with a dedicated wide image', async () => {
    const [layout, card, cardPng] = await Promise.all([
      read('site/src/layouts/BaseLayout.astro'),
      read('site/public/assets/social-card.svg'),
      readBinary('site/public/assets/social-card.png'),
    ]);

    assert.match(layout, /socialImage\s*=\s*['"]https:\/\/clueside\.com\/assets\/social-card\.png['"]/);
    assert.match(layout, /property="og:site_name"/);
    assert.match(layout, /property="og:image" content=\{socialImage\}/);
    assert.match(layout, /property="og:image:secure_url" content=\{socialImage\}/);
    assert.match(layout, /property="og:image:type" content="image\/png"/);
    assert.match(layout, /property="og:image:width" content="1200"/);
    assert.match(layout, /property="og:image:height" content="630"/);
    assert.match(layout, /property="og:image:alt" content=\{socialImageAlt\}/);
    assert.match(layout, /name="twitter:card" content="summary_large_image"/);
    assert.match(layout, /name="twitter:image" content=\{socialImage\}/);
    assert.match(layout, /name="twitter:image:alt" content=\{socialImageAlt\}/);
    assert.match(card, /viewBox="0 0 1200 630"/);
    assert.deepEqual([...cardPng.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(cardPng.readUInt32BE(16), 1200);
    assert.equal(cardPng.readUInt32BE(20), 630);
  });

  it('ships production browser security headers', async () => {
    const headers = await read('site/public/_headers');
    assert.match(headers, /Strict-Transport-Security: max-age=31536000; includeSubDomains/);
    assert.match(headers, /Content-Security-Policy: default-src 'self'/);
    assert.match(headers, /script-src 'self'/);
    assert.match(headers, /frame-ancestors 'none'/);
  });

  it('keeps extension packaging independent from site output', async () => {
    const packaging = await read('scripts/package.mjs');
    assert.doesNotMatch(packaging, /site\/dist/);
    assert.doesNotMatch(packaging, /site\/src/);
  });
});
