import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_BASE64_CHARS,
  readResponseBytes,
} from '../src/image-limits.js';

describe('bounded image response reads', () => {
  it('rejects an oversized declared Content-Length before reading', async () => {
    const response = new Response(new Uint8Array([1]), {
      headers: { 'content-length': '6' },
    });
    await assert.rejects(readResponseBytes(response, 5), /size cap/);
  });

  it('rejects a chunked response once streamed bytes cross the cap', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    });
    await assert.rejects(readResponseBytes(new Response(stream), 5), /size cap/);
  });

  it('reassembles a response that stays within the cap', async () => {
    const buffer = await readResponseBytes(new Response(Uint8Array.from([1, 2, 3, 4])), 4);
    assert.deepEqual([...new Uint8Array(buffer)], [1, 2, 3, 4]);
  });

  it('keeps the transport limit aligned with the decoded-byte limit', () => {
    assert.equal(MAX_IMAGE_BASE64_CHARS, 4 * Math.ceil(MAX_IMAGE_BYTES / 3));
  });
});
