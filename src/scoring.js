/**
 * CommunityForensics neural score: sigmoid(single logit) as raw p(AI).
 * Threshold stays 0.65 with no UI remapping.
 */

import { DEFAULT_THRESHOLD } from './fuse.js';

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

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

export { DEFAULT_THRESHOLD };
