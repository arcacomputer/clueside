import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVersions,
  isNewerVersion,
  normalizeVersion,
  parseLatestRelease,
  pickDownloadUrl,
  shouldShowUpdateBanner,
} from '../src/update-checker.js';

describe('normalizeVersion', () => {
  it('strips a leading v and validates dotted versions', () => {
    assert.equal(normalizeVersion('v1.0.3'), '1.0.3');
    assert.equal(normalizeVersion('1.2'), '1.2');
    assert.equal(normalizeVersion('bad'), null);
    assert.equal(normalizeVersion(''), null);
  });
});

describe('compareVersions', () => {
  it('orders semantic-ish versions', () => {
    assert.equal(compareVersions('1.0.3', '1.0.2'), 1);
    assert.equal(compareVersions('1.0.2', '1.0.3'), -1);
    assert.equal(compareVersions('1.0.2', '1.0.2'), 0);
    assert.equal(compareVersions('v2.0.0', '1.9.9'), 1);
  });
});

describe('isNewerVersion', () => {
  it('detects newer remote versions', () => {
    assert.equal(isNewerVersion('1.0.3', '1.0.2'), true);
    assert.equal(isNewerVersion('1.0.2', '1.0.2'), false);
    assert.equal(isNewerVersion('1.0.1', '1.0.2'), false);
  });
});

describe('pickDownloadUrl', () => {
  it('prefers the Clueside release zip asset', () => {
    const url = pickDownloadUrl({
      html_url: 'https://github.com/arcacomputer/clueside/releases/tag/v1.0.3',
      assets: [
        {
          name: 'clueside-1.0.3.zip',
          browser_download_url:
            'https://github.com/arcacomputer/clueside/releases/download/v1.0.3/clueside-1.0.3.zip',
        },
      ],
    });
    assert.match(url, /clueside-1\.0\.3\.zip$/);
  });

  it('keeps migrated release assets downloadable', () => {
    const url = pickDownloadUrl({
      html_url: 'https://github.com/arcacomputer/clueside/releases/tag/v1.0.8',
      assets: [
        {
          name: 'hybrid-ai-image-detector-1.0.8.zip',
          browser_download_url:
            'https://github.com/arcacomputer/clueside/releases/download/v1.0.8/hybrid-ai-image-detector-1.0.8.zip',
        },
      ],
    });
    assert.match(url, /hybrid-ai-image-detector-1\.0\.8\.zip$/);
  });

  it('falls back to the release page when the zip asset is missing', () => {
    const url = pickDownloadUrl({
      html_url: 'https://github.com/arcacomputer/clueside/releases/tag/v1.0.3',
      assets: [],
    });
    assert.equal(
      url,
      'https://github.com/arcacomputer/clueside/releases/tag/v1.0.3'
    );
  });

  it('rejects non-GitHub and wrong-repository update links', () => {
    assert.equal(
      pickDownloadUrl({
        html_url: 'javascript:alert(1)',
        assets: [
          {
            name: 'hybrid-ai-image-detector-9.9.9.zip',
            browser_download_url: 'https://attacker.example/payload.zip',
          },
        ],
      }),
      null
    );
    assert.equal(
      pickDownloadUrl({
        html_url: 'https://github.com/another/repository/releases/tag/v9.9.9',
        assets: [],
      }),
      null
    );
  });
});

describe('parseLatestRelease', () => {
  it('returns version and download URL from a GitHub payload', () => {
    const parsed = parseLatestRelease({
      tag_name: 'v1.0.3',
      html_url: 'https://github.com/arcacomputer/clueside/releases/tag/v1.0.3',
      assets: [
        {
          name: 'hybrid-ai-image-detector-1.0.3.zip',
          browser_download_url:
            'https://github.com/arcacomputer/clueside/releases/download/v1.0.3/hybrid-ai-image-detector-1.0.3.zip',
        },
      ],
    });

    assert.deepEqual(parsed, {
      version: '1.0.3',
      downloadUrl:
        'https://github.com/arcacomputer/clueside/releases/download/v1.0.3/hybrid-ai-image-detector-1.0.3.zip',
    });
  });
});

describe('shouldShowUpdateBanner', () => {
  it('shows when remote is newer and not dismissed', () => {
    assert.equal(
      shouldShowUpdateBanner({
        manifestVersion: '1.0.2',
        remoteVersion: '1.0.3',
        dismissedVersion: null,
      }),
      true
    );
  });

  it('hides when remote matches manifest or was dismissed', () => {
    assert.equal(
      shouldShowUpdateBanner({
        manifestVersion: '1.0.2',
        remoteVersion: '1.0.2',
        dismissedVersion: null,
      }),
      false
    );
    assert.equal(
      shouldShowUpdateBanner({
        manifestVersion: '1.0.2',
        remoteVersion: '1.0.3',
        dismissedVersion: '1.0.3',
      }),
      false
    );
  });
});
