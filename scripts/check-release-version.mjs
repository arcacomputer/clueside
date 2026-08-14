import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const RELEASE_TAG = /^v(\d+\.\d+\.\d+)$/;

export function assertReleaseVersion(tag, packageVersion, manifestVersion) {
  const match = RELEASE_TAG.exec(String(tag || ''));
  if (!match) {
    throw new Error(`release tag must match vX.Y.Z; received ${tag || '(empty)'}`);
  }

  if (packageVersion !== manifestVersion) {
    throw new Error(
      `package version ${packageVersion} does not match manifest version ${manifestVersion}`
    );
  }

  const tagVersion = match[1];
  if (tagVersion !== packageVersion) {
    throw new Error(`tag ${tag} does not match package version ${packageVersion}`);
  }

  return tagVersion;
}

async function main() {
  const tag = process.argv[2] || process.env.GITHUB_REF_NAME;
  const [pkg, manifest] = await Promise.all([
    readFile(resolve(ROOT, 'package.json'), 'utf8').then(JSON.parse),
    readFile(resolve(ROOT, 'manifest.json'), 'utf8').then(JSON.parse),
  ]);

  const version = assertReleaseVersion(tag, pkg.version, manifest.version);
  console.log(`Release version verified: v${version}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
