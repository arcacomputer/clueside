import { DEFAULT_THRESHOLD, fuseNeuralScores } from '../src/fuse.js';
import { effectiveTtaMode, fuseInferenceScores } from '../src/inference-policy.js';
import { foldTtaScores } from '../src/scoring.js';

export const PRODUCT_VIEW_ORDER = ['center', 'tl', 'tr', 'bl', 'br', 'center_512'];

/**
 * Mirror the extension's fixed production TTA behavior. A reporting threshold
 * supplied to eval/analyze.mjs must not change which views production runs.
 *
 * @param {{views: Record<string, number>}} rec
 * @param {number|null|undefined} dino
 */
export function productFold(rec, dino) {
  const scores = PRODUCT_VIEW_ORDER
    .map((name) => rec.views[name])
    .filter((score) => score != null);
  const mode = effectiveTtaMode('adaptive', dino ?? null);
  return foldTtaScores(scores, { mode });
}

export function productCfScore(rec, dino) {
  return productFold(rec, dino).neuralPAi;
}

/** Mirror the current production neural policy through shared source modules. */
export function productNeuralScore(rec, dino) {
  const folded = productFold(rec, dino);
  return fuseNeuralScores(folded.neuralPAi, dino ?? null, {
    graphicGate: rec.graphicGate === true,
    agreementFallback: folded.agreementFallback === true,
  });
}

/** Convert compact sweep metadata back into the shared fusion shape. */
export function heuristicSignalsForSweep(rec) {
  return {
    c2paAi: rec.heur?.c2pa === true,
    c2paReason: rec.heur?.c2paReason ?? null,
    metadataAi: rec.heur?.meta === true,
    metadataReason: rec.heur?.metadataReason ?? null,
    urlHint: rec.heur?.url === true,
    urlHintReason: rec.heur?.urlHintReason ?? null,
    freqResidualVote: Number(rec.heur?.freq) || 0,
    reasons: Array.isArray(rec.heur?.reasons) ? rec.heur.reasons : [],
  };
}

/** Mirror the complete current raw score, including deterministic metadata. */
export function productRawScore(rec, dino) {
  const folded = productFold(rec, dino);
  return fuseInferenceScores(
    folded.neuralPAi,
    dino ?? null,
    heuristicSignalsForSweep(rec),
    DEFAULT_THRESHOLD,
    {
      graphicGate: rec.graphicGate === true,
      agreementFallback: folded.agreementFallback === true,
    }
  ).rawScore;
}

/**
 * Mirror fixed CF-primary production fusion for offline policy analysis.
 *
 * @param {{views: Record<string, number>}} rec
 * @param {number|null|undefined} dino
 * @param {number} floor
 */
export function productFloorScore(rec, dino, floor) {
  const cf = productCfScore(rec, dino);
  if (dino == null || cf >= DEFAULT_THRESHOLD || cf < floor) return cf;
  if (rec.graphicGate === true) return cf;
  return Math.max(cf, dino);
}
