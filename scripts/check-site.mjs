#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const site = join(root, 'site');
const required = ['index.html', 'styles.css', 'app.js', 'assets/mark.svg'];
for (const file of required) await access(join(site, file));

const html = await readFile(join(site, 'index.html'), 'utf8');
const brandedFiles = ['site/index.html', 'site/assets/mark.svg', 'README.md'];
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
];
for (const phrase of banned) {
  if (html.includes(phrase)) throw new Error(`Banned or misleading claim in site: ${phrase}`);
}
for (const phrase of [
  '96.1%',
  '893-image',
  'illustrative',
  'Images never leave your device',
  'The clues stay',
  'Eligible images',
  'current v1.0.8',
  'legacy raw-max policy',
  'Current policy',
  'not shipped',
]) {
  if (!html.includes(phrase)) throw new Error(`Required site disclosure missing: ${phrase}`);
}
if (/—/.test(html)) throw new Error('Public copy contains an em dash');

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicates.length) throw new Error(`Duplicate HTML ids: ${[...new Set(duplicates)].join(', ')}`);

console.log('Site check passed. Claims, required assets, and basic HTML invariants verified.');
