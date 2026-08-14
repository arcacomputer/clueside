import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertReleaseVersion } from '../scripts/check-release-version.mjs';

describe('release version guard', () => {
  it('accepts a v-prefixed tag matching package and manifest', () => {
    assert.equal(assertReleaseVersion('v1.0.9', '1.0.9', '1.0.9'), '1.0.9');
  });

  it('rejects a tag that does not match the packaged version', () => {
    assert.throws(
      () => assertReleaseVersion('v1.0.10', '1.0.9', '1.0.9'),
      /tag v1\.0\.10 does not match package version 1\.0\.9/
    );
  });

  it('rejects package and manifest drift', () => {
    assert.throws(
      () => assertReleaseVersion('v1.0.9', '1.0.9', '1.0.8'),
      /package version 1\.0\.9 does not match manifest version 1\.0\.8/
    );
  });

  it('rejects malformed release tags', () => {
    assert.throws(
      () => assertReleaseVersion('release-1.0.9', '1.0.9', '1.0.9'),
      /release tag must match vX\.Y\.Z/
    );
  });
});
