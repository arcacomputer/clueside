import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

const wrangler = fileURLToPath(new URL('../site/node_modules/.bin/wrangler', import.meta.url));
const config = 'wrangler.jsonc';
const tag = process.env.GITHUB_SHA || `manual-${Date.now()}`;
const message = process.env.GITHUB_SHA ? `GitHub ${process.env.GITHUB_SHA}` : `Manual ${tag}`;

function run(args) {
  const result = spawnSync(wrangler, args, {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(['versions', 'upload', '--config', config, '--tag', tag, '--message', message]);
run([
  'versions',
  'deploy',
  '--config',
  config,
  '--version-tag',
  tag,
  '--percentage',
  '100',
  '--yes',
  '--message',
  message,
]);
