import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickImageUrl } from '../src/image-url.js';

describe('pickImageUrl', () => {
  it('prefers currentSrc over src and srcset leftovers', () => {
    const url = pickImageUrl({
      currentSrc: 'https://cdn.example/visible.jpg',
      src: 'https://cdn.example/lazy-placeholder.jpg',
      complete: true,
    });
    assert.equal(url, 'https://cdn.example/visible.jpg');
  });

  it('waits when lazy images have no currentSrc yet', () => {
    assert.equal(pickImageUrl({ src: 'https://cdn.example/later.jpg', complete: false }), '');
    assert.equal(pickImageUrl({ src: 'https://cdn.example/done.jpg', complete: true }), 'https://cdn.example/done.jpg');
  });
});
