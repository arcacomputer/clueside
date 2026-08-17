/**
 * CommunityForensics neural score: sigmoid(single logit) as raw p(AI).
 * Threshold stays 0.65 with no UI remapping.
 */

import { DEFAULT_THRESHOLD } from './fuse.js';

/** Extra CLIP crops run only when center p(AI) is in this band. */
export const TTA_ADAPTIVE_LOW = 0.15;

/**
 * A single view at or above this score carries the verdict on its own and
 * stops remaining crops. Below it, a mid-band AI verdict needs agreement
 * (see CF_AGREEMENT_MIN_VIEWS): live CDN-processed real photos can spike
 * one crop into the 0.65 to 0.95 band while every other crop stays low,
 * and a lone spiked crop is weak evidence. 0.85 was too low: Unsplash
 * featured-feed center crops land in 0.81-0.94 and would early-exit
 * before extras could disagree.
 */
export const TTA_EARLY_EXIT = 0.95;

/** Views at or above the threshold required for a mid-band CF verdict. */
export const CF_AGREEMENT_MIN_VIEWS = 2;

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
 * Extra 440-corner / 512-center crops only help when the official center
 * crop is uncertain. A confident real (for example 0.04) will not become
 * 0.65 by taking the max of six similar scores. The band now extends
 * through the mid-band verdict range so a center crop in [0.65, 0.95)
 * gathers corroborating views before the agreement rule judges it.
 * @param {number} centerScore
 */
export function shouldRunExtraCrops(centerScore) {
  const p = clamp01(centerScore);
  return p >= TTA_ADAPTIVE_LOW && p < TTA_EARLY_EXIT;
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
    return { neuralPAi: 0.5, extraRan: false, earlyExit: false, used: [], agreementFallback: false };
  }

  const center = clamp01(scores[0]);
  const used = [center];

  if (center >= earlyExit) {
    return { neuralPAi: center, extraRan: false, earlyExit: true, used, agreementFallback: false };
  }

  const runExtra =
    mode === 'always' || (mode === 'adaptive' && shouldRunExtraCrops(center));

  if (!runExtra) {
    return { neuralPAi: center, extraRan: false, earlyExit: false, used, agreementFallback: false };
  }

  let max = center;
  for (let i = 1; i < scores.length; i++) {
    const v = clamp01(scores[i]);
    used.push(v);
    if (v > max) max = v;
    if (v >= earlyExit) {
      return { neuralPAi: max, extraRan: true, earlyExit: true, used, agreementFallback: false };
    }
  }

  const neuralPAi = agreedMax(max, used, threshold);
  return {
    neuralPAi,
    extraRan: true,
    earlyExit: false,
    used,
    agreementFallback: neuralPAi < max && max >= threshold,
  };
}

/**
 * Mid-band agreement rule. A max in [threshold, TTA_EARLY_EXIT) stands only
 * when at least CF_AGREEMENT_MIN_VIEWS inspected views reach the threshold;
 * otherwise CF falls back to the second-highest view. Views at or above
 * TTA_EARLY_EXIT never reach here (they exit above with full authority).
 * Single-view images keep their score: there is nothing to disagree.
 * Shared by foldTtaScores and the live predictAdaptiveViews path.
 * @param {number} max
 * @param {number[]} used
 * @param {number} threshold
 */
export function agreedMax(max, used, threshold = DEFAULT_THRESHOLD) {
  if (max < threshold || used.length < 2) return max;
  const above = used.filter((v) => v >= threshold).length;
  if (above >= CF_AGREEMENT_MIN_VIEWS) return max;
  let second = 0;
  for (const v of used) {
    if (v < max && v > second) second = v;
  }
  // Duplicate maxima count as agreement and were caught above; here the
  // max is unique, so second is the true runner-up.
  return second;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

export { DEFAULT_THRESHOLD };
