#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const site = join(root, 'site', 'dist');
const required = [
  'index.html',
  '404.html',
  'styles.css',
  'app.js',
  'assets/mark.svg',
  'assets/social-card.svg',
  'assets/social-card.png',
  'robots.txt',
  'sitemap-index.xml',
  'sitemap-0.xml',
  '_headers',
];
for (const file of required) await access(join(site, file));

const html = await readFile(join(site, 'index.html'), 'utf8');
const brandedFiles = [
  'site/src/pages/index.astro',
  'site/public/assets/mark.svg',
  'README.md',
];
for (const file of brandedFiles) {
  const content = await readFile(join(root, file), 'utf8');
  if (!content.includes('Clueside')) throw new Error(`Product name missing from ${file}`);
}
const banned = [
  'Kenny’s private score',
  'Kenny\'s private score',
  '100% accurate',
  'Tellmark',
  'Tellframe',
  'The shipped policy was tested',
  'FULLY REPRODUCIBLE',
];
for (const phrase of banned) {
  if (html.includes(phrase)) throw new Error(`Banned or misleading claim in site: ${phrase}`);
}
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const bench = JSON.parse(await readFile(join(root, 'eval', 'benchmark-results.json'), 'utf8'));
for (const phrase of [
  `${bench.legacyRawMax.ba}%`,
  `${bench.bench.ba}%`,
  `TPR ${bench.bench.tpr}%`,
  `TNR ${bench.bench.tnr}%`,
  `${bench.bench.n}-image`,
  `${bench.stress.n}-image`,
  'illustrative',
  'Images never leave your device',
  'The clues stay',
  'Eligible images',
  `current v${pkg.version}`,
  'legacy raw-max policy',
  'Current policy',
  'not shipped',
  'PUBLIC BUILD STEPS',
  'eligible, successfully analyzed image',
]) {
  if (!html.includes(phrase)) throw new Error(`Required site disclosure missing: ${phrase}`);
}
if (/—/.test(html)) throw new Error('Public copy contains an em dash');

for (const metadata of [
  '<meta property="og:site_name" content="Clueside">',
  '<meta property="og:image" content="https://clueside.com/assets/social-card.png">',
  '<meta property="og:image:width" content="1200">',
  '<meta property="og:image:height" content="630">',
  '<meta name="twitter:card" content="summary_large_image">',
  '<meta name="twitter:image" content="https://clueside.com/assets/social-card.png">',
]) {
  if (!html.includes(metadata)) throw new Error(`Required sharing metadata missing: ${metadata}`);
}

const robots = await readFile(join(site, 'robots.txt'), 'utf8');
if (!robots.includes('https://clueside.com/sitemap-index.xml')) {
  throw new Error('robots.txt does not point to the generated sitemap index');
}

const sitemap = await readFile(join(site, 'sitemap-0.xml'), 'utf8');
if (!sitemap.includes('<loc>https://clueside.com/</loc>')) {
  throw new Error('Generated sitemap is missing the canonical homepage');
}

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicates.length) throw new Error(`Duplicate HTML ids: ${[...new Set(duplicates)].join(', ')}`);

console.log('Site check passed. Claims, required assets, and basic HTML invariants verified.');
