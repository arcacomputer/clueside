import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../site/worker.js';

describe('Clueside hostname worker', () => {
  it('redirects www to the canonical apex while preserving path and query', async () => {
    const response = await worker.fetch(
      new Request('https://www.clueside.com/evidence?from=www'),
      { ASSETS: { fetch: () => assert.fail('redirect must not read assets') } }
    );

    assert.equal(response.status, 308);
    assert.equal(response.headers.get('location'), 'https://clueside.com/evidence?from=www');
  });

  it('redirects production HTTP requests to the HTTPS apex', async () => {
    for (const hostname of ['clueside.com', 'www.clueside.com']) {
      const response = await worker.fetch(
        new Request(`http://${hostname}/evidence?source=browser`),
        { ASSETS: { fetch: () => assert.fail('redirect must not read assets') } }
      );

      assert.equal(response.status, 308);
      assert.equal(response.headers.get('location'), 'https://clueside.com/evidence?source=browser');
    }
  });

  it('serves apex requests from the static asset binding', async () => {
    const request = new Request('https://clueside.com/');
    let delegated;
    const response = await worker.fetch(request, {
      ASSETS: {
        fetch(received) {
          delegated = received;
          return new Response('astro asset');
        },
      },
    });

    assert.equal(delegated, request);
    assert.equal(await response.text(), 'astro asset');
  });
});
