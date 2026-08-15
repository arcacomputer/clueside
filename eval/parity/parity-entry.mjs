/**
 * Browser parity harness entry. Bundled by eval/parity/build.mjs and
 * served by eval/parity/server.mjs. Runs the EXACT product path:
 * createImageBitmap -> pillowResize crop views (src/clip-preprocess.js) ->
 * onnxruntime-web WASM (src/community-forensics.js), plus the shared
 * flat-graphic gate (src/graphic-gate.js) applied to the CF+DINO fusion
 * the same way src/offscreen.js and eval/harness.mjs apply it, over a
 * manifest of benchmark images, and dumps per-view sigmoids as JSON.
 *
 * Query params:
 *   ?limit=40    cap image count
 */

import * as ort from 'onnxruntime-web';
import { preprocessBitmapViews } from '../../src/clip-preprocess.js';
import { analyzeGraphicGate } from '../../src/graphic-gate.js';
import { fuseNeuralScores } from '../../src/fuse.js';
import { createCommunityForensicsSession, predictViews } from '../../src/community-forensics.js';
import {
  DINO_INPUT_NAME,
  DINO_CROP_SIZE,
  dinoPreprocessBitmap,
  dinoScoreHiddenState,
} from '../../src/dino.js';

const params = new URLSearchParams(location.search);
const LIMIT = Number(params.get('limit') || 40);

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
      const graphicGate = analyzeGraphicGate(bitmap).isGraphic;
      const views = await preprocessBitmapViews(bitmap);

      let dino = null;
      if (dinoSession && dinoProbe) {
        const chw = dinoPreprocessBitmap(bitmap);
        const input = new ort.Tensor('float32', chw, [1, 3, DINO_CROP_SIZE, DINO_CROP_SIZE]);
        const outputs = await dinoSession.run({ [DINO_INPUT_NAME]: input });
        dino = dinoScoreHiddenState(outputs.last_hidden_state, dinoProbe);
      }
      bitmap.close();

      const { named, neuralPAi } = await predictViews(session, views);
      const viewsOut = {};
      for (const v of named) viewsOut[v.name] = v.score;
      // Same gate application as production: the flat-graphic gate
      // suppresses DINO lift inside fuseNeuralScores.
      const fused = fuseNeuralScores(neuralPAi, dino, { graphicGate });
      results.push({
        file: item.name,
        label: item.label,
        views: viewsOut,
        dino,
        cf: neuralPAi,
        graphic_gate: graphicGate,
        fused,
      });
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
