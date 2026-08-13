/**
 * Fuse neural p(AI) with deterministic metadata signals.
 * Eval threshold is raw fused score >= 0.65 (no remapping).
 */

export const DEFAULT_THRESHOLD = 0.65;
export const UNCERTAIN_LOW = 0.45;
export const URL_HINT_MAX_BOOST = 0.05;

/**
 * @typedef {object} HeuristicSignals
 * @property {boolean} c2paAi
 * @property {string|null} c2paReason
 * @property {boolean} metadataAi
 * @property {string|null} metadataReason
 * @property {boolean} urlHint
 * @property {string|null} urlHintReason
 * @property {number} freqResidualVote
 * @property {string[]} reasons
 */

/**
 * @typedef {object} FusionResult
 * @property {number} rawScore
 * @property {number} neuralScore
 * @property {string} verdict
 * @property {string[]} reasons
 * @property {boolean} forcedByMetadata
 */

/**
 * @param {number} neuralPAi - Raw p(AI) from CommunityForensics sigmoid(logit)
 * @param {HeuristicSignals} signals
 * @param {number} [threshold]
 * @returns {FusionResult}
 */
export function fuseScores(neuralPAi, signals, threshold = DEFAULT_THRESHOLD) {
  const reasons = [...(signals.reasons || [])];
  let rawScore = clamp01(neuralPAi);
  let forcedByMetadata = false;

  if (signals.c2paAi) {
    rawScore = signals.c2paReason?.includes('composite') ? 0.95 : 0.99;
    if (signals.c2paReason) reasons.unshift(signals.c2paReason);
    forcedByMetadata = true;
  } else if (signals.metadataAi) {
    rawScore = 0.97;
    if (signals.metadataReason) reasons.unshift(signals.metadataReason);
    forcedByMetadata = true;
  } else {
    let nonUrlScore = rawScore;

    if (signals.freqResidualVote > 0 && nonUrlScore >= UNCERTAIN_LOW && nonUrlScore < threshold) {
      nonUrlScore = clamp01(nonUrlScore + signals.freqResidualVote * 0.03);
      reasons.push('Frequency residual weak signal');
    }

    rawScore = nonUrlScore;

    if (signals.urlHint) {
      const boosted = nonUrlScore + URL_HINT_MAX_BOOST;
      if (nonUrlScore < threshold) {
        rawScore = Math.min(boosted, threshold - 1e-6);
      } else {
        rawScore = clamp01(boosted);
      }
      if (signals.urlHintReason) reasons.push(signals.urlHintReason);
    }
  }

  const verdict = classifyVerdict(rawScore, threshold);

  return {
    rawScore,
    neuralScore: clamp01(neuralPAi),
    verdict,
    reasons: dedupe(reasons),
    forcedByMetadata,
  };
}

/**
 * @param {number} rawScore
 * @param {number} [threshold]
 * @returns {'ai'|'uncertain'|'real'}
 */
export function classifyVerdict(rawScore, threshold = DEFAULT_THRESHOLD) {
  if (rawScore >= threshold) return 'ai';
  if (rawScore >= UNCERTAIN_LOW) return 'uncertain';
  return 'real';
}

/**
 * @param {number} rawScore
 * @param {number} [threshold]
 * @returns {boolean}
 */
export function isAiAtThreshold(rawScore, threshold = DEFAULT_THRESHOLD) {
  return rawScore >= threshold;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function dedupe(arr) {
  return [...new Set(arr.filter(Boolean))];
}
