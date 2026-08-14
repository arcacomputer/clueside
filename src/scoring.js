/**
 * CommunityForensics neural score: sigmoid(single logit) as raw p(AI).
 * Threshold stays 0.65 with no UI remapping.
 */

import { DEFAULT_THRESHOLD } from './fuse.js';

/** Extra CLIP crops run only when center p(AI) is in this band. */
export const TTA_ADAPTIVE_LOW = 0.15;

/** Stop remaining crops once any sigmoid is this high. */
export const TTA_EARLY_EXIT = 0.9;

export const TTA_MODES = ['adaptive', 'always', 'center'];

export function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

export function logitAtProbability(p) {
  const clamped = Math.max(1e-6, Math.min(1 - 1e-6, p));
  return Math.log(clamped / (1 - clamped));
}

/**
 * @param {number} logit
 * @returns {number} raw p(AI) in [0, 1]
 */
export function neuralPAiFromLogit(logit) {
  return clamp01(sigmoid(logit));
}

/**
 * Honest aggregation of per-view sigmoid scores. Max, not a stretch.
 * @param {number[]} scores
 * @returns {number}
 */
export function aggregateViewScores(scores) {
  if (!scores?.length) return 0.5;
  let max = 0;
  for (const score of scores) {
    const v = clamp01(score);
    if (v > max) max = v;
  }
  return max;
}

/**
 * Production TTA aggregation. Average the official center prediction with the
 * strongest inspected view so one anomalous corner cannot become the entire
 * CF score. This is an average of raw sigmoid probabilities, not a remap.
 * @param {number[]} scores center score first, followed by inspected extras
 * @returns {number}
 */
export function aggregateProductionViewScores(scores) {
  if (!scores?.length) return 0.5;
  const center = clamp01(scores[0]);
  return (center + aggregateViewScores(scores)) / 2;
}

/**
 * Extra 440-corner / 512-center crops only help when the official center
 * crop is uncertain. A confident real (for example 0.04) will not become
 * 0.65 by taking the max of six similar scores.
 * @param {number} centerScore
 * @param {number} [threshold]
 */
export function shouldRunExtraCrops(centerScore, threshold = DEFAULT_THRESHOLD) {
  const p = clamp01(centerScore);
  return p >= TTA_ADAPTIVE_LOW && p < threshold;
}

/**
 * Fold already-computed view scores with the production TTA policy.
 * scores[0] is the official 440 center crop.
 *
 * @param {number[]} scores
 * @param {{
 *   mode?: 'adaptive' | 'always' | 'center',
 *   threshold?: number,
 *   earlyExit?: number,
 * }} [options]
 */
export function foldTtaScores(scores, options = {}) {
  const mode = options.mode || 'adaptive';
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const earlyExit = options.earlyExit ?? TTA_EARLY_EXIT;

  if (!scores?.length) {
    return { neuralPAi: 0.5, extraRan: false, earlyExit: false, used: [] };
  }

  const center = clamp01(scores[0]);
  const used = [center];

  if (center >= earlyExit) {
    return { neuralPAi: center, extraRan: false, earlyExit: true, used };
  }

  const runExtra =
    mode === 'always' || (mode === 'adaptive' && shouldRunExtraCrops(center, threshold));

  if (!runExtra) {
    return { neuralPAi: center, extraRan: false, earlyExit: false, used };
  }

  for (let i = 1; i < scores.length; i++) {
    const v = clamp01(scores[i]);
    used.push(v);
    if (v >= earlyExit) {
      return {
        neuralPAi: aggregateProductionViewScores(used),
        extraRan: true,
        earlyExit: true,
        used,
      };
    }
  }

  return {
    neuralPAi: aggregateProductionViewScores(used),
    extraRan: true,
    earlyExit: false,
    used,
  };
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

export { DEFAULT_THRESHOLD };
