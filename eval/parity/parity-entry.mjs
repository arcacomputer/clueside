/**
 * Browser parity harness entry. Bundled by eval/parity/build.mjs and
 * served by eval/parity/server.mjs. Runs the EXACT product path:
 * createImageBitmap -> canvas resize/crop (src/clip-preprocess.js) ->
 * onnxruntime-web WASM (src/community-forensics.js), over a manifest of
 * benchmark images, and dumps per-view sigmoids as JSON.
 *
 * Query params:
 *   ?smooth=low  force imageSmoothingQuality back to 'low' (A/B probe)
 *   ?limit=40    cap image count
 */

import * as ort from 'onnxruntime-web';
import { preprocessBitmapViews } from '../../src/clip-preprocess.js';
import { createCommunityForensicsSession, predictViews } from '../../src/community-forensics.js';
import {
  DINO_INPUT_NAME,
  DINO_CROP_SIZE,
  dinoPreprocessBitmap,
  dinoScoreHiddenState,
} from '../../src/dino.js';

const params = new URLSearchParams(location.search);
const LIMIT = Number(params.get('limit') || 40);

if (params.get('smooth') === 'low') {
  const proto = OffscreenCanvasRenderingContext2D.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'imageSmoothingQuality');
  Object.defineProperty(proto, 'imageSmoothingQuality', {
    get() {
      return desc.get.call(this);
    },
    set() {
      desc.set.call(this, 'low');
    },
  });
}

const out = document.getElementById('out');
const status = document.getElementById('status');

function log(msg) {
  status.textContent = msg;
}

async function main() {
  log('loading manifest...');
  const manifest = await (await fetch('/manifest.json')).json();
  const items = manifest.slice(0, LIMIT);

  log('creating ORT session (wasm)...');
  const { session, device } = await createCommunityForensicsSession({
    modelUrl: '/models-file',
    wasmPaths: '/ort/',
    preferWebGpu: false,
    verifyWasmAssets: false,
  });

  let dinoSession = null;
  let dinoProbe = null;
  try {
    const probeRes = await fetch('/probe.json');
    if (probeRes.ok) {
      dinoProbe = await probeRes.json();
      dinoSession = await ort.InferenceSession.create('/dino-file', {
        executionProviders: ['wasm'],
      });
      log('dino head loaded');
    }
  } catch (err) {
    log(`dino head unavailable: ${err?.message || err}`);
  }

  const results = [];
  let i = 0;
  for (const item of items) {
    i++;
    log(`${i}/${items.length} ${item.name} (${device})`);
    try {
      const res = await fetch(item.url);
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      const views = await preprocessBitmapViews(bitmap);

      let dino = null;
      if (dinoSession && dinoProbe) {
        const chw = dinoPreprocessBitmap(bitmap);
        const input = new ort.Tensor('float32', chw, [1, 3, DINO_CROP_SIZE, DINO_CROP_SIZE]);
        const outputs = await dinoSession.run({ [DINO_INPUT_NAME]: input });
        dino = dinoScoreHiddenState(outputs.last_hidden_state, dinoProbe);
      }
      bitmap.close();

      const { named } = await predictViews(session, views);
      const viewsOut = {};
      for (const v of named) viewsOut[v.name] = v.score;
      results.push({ file: item.name, label: item.label, views: viewsOut, dino });
    } catch (err) {
      results.push({ file: item.name, label: item.label, error: String(err?.message || err) });
    }
    out.textContent = JSON.stringify(results);
  }

  out.textContent = JSON.stringify(results);
  out.dataset.done = '1';
  log(`done: ${results.length} images on ${device}`);
}

main().catch((err) => {
  log(`FATAL: ${err?.message || err}`);
  out.dataset.done = 'error';
});
