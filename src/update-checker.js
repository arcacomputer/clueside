export const GITHUB_OWNER = 'felirami';
export const GITHUB_REPO = 'hybrid-ai-image-detector';
export const GITHUB_LATEST_RELEASE_URL =
  `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
export const RELEASE_ZIP_PREFIX = 'hybrid-ai-image-detector-';
const RELEASE_PATH_PREFIX = `/${GITHUB_OWNER}/${GITHUB_REPO}/releases/`;

const VERSION_PARTS = /^\d+(?:\.\d+){0,2}$/;

/**
 * Normalize a tag or version string (e.g. "v1.0.3") to "1.0.3".
 */
export function normalizeVersion(version) {
  if (typeof version !== 'string') return null;
  const trimmed = version.trim().replace(/^v/i, '');
  if (!VERSION_PARTS.test(trimmed)) return null;
  const parts = trimmed.split('.').map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part))) return null;
  return parts.join('.');
}

/**
 * Compare dotted versions. Returns 1 if a > b, -1 if a < b, 0 if equal or invalid.
 */
export function compareVersions(a, b) {
  const left = normalizeVersion(a);
  const right = normalizeVersion(b);
  if (!left || !right) return 0;

  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let i = 0; i < length; i += 1) {
    const lv = leftParts[i] ?? 0;
    const rv = rightParts[i] ?? 0;
    if (lv > rv) return 1;
    if (lv < rv) return -1;
  }

  return 0;
}

export function isNewerVersion(remote, local) {
  return compareVersions(remote, local) > 0;
}

/**
 * Pick the Load-unpacked zip URL from a GitHub latest-release payload.
 */
export function pickDownloadUrl(release) {
  if (!release || typeof release !== 'object') return null;

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const zipAsset = assets.find(
    (asset) =>
      typeof asset?.name === 'string' &&
      asset.name.startsWith(RELEASE_ZIP_PREFIX) &&
      asset.name.endsWith('.zip') &&
      typeof asset.browser_download_url === 'string'
  );

  if (zipAsset?.browser_download_url && isTrustedReleaseUrl(zipAsset.browser_download_url)) {
    return zipAsset.browser_download_url;
  }

  if (
    typeof release.html_url === 'string' &&
    release.html_url.length > 0 &&
    isTrustedReleaseUrl(release.html_url)
  ) {
    return release.html_url;
  }

  return null;
}

function isTrustedReleaseUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.pathname.startsWith(RELEASE_PATH_PREFIX)
    );
  } catch {
    return false;
  }
}

export function parseLatestRelease(release) {
  if (!release || typeof release !== 'object') return null;

  const version = normalizeVersion(release.tag_name);
  const downloadUrl = pickDownloadUrl(release);
  if (!version || !downloadUrl) return null;

  return { version, downloadUrl };
}

export function shouldShowUpdateBanner({
  manifestVersion,
  remoteVersion,
  dismissedVersion,
}) {
  if (!remoteVersion || !manifestVersion) return false;
  if (!isNewerVersion(remoteVersion, manifestVersion)) return false;
  if (dismissedVersion && dismissedVersion === remoteVersion) return false;
  return true;
}
