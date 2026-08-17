/**
 * Fuse neural p(AI) with deterministic metadata signals.
 * Eval threshold is raw fused score >= 0.65 (no remapping).
 */

export const DEFAULT_THRESHOLD = 0.65;
export const UNCERTAIN_LOW = 0.45;
/** CF scores below this need the saturated sub-floor tier to be rescued. */
export const DINO_CF_FLOOR = 0.02;
/** CF below this requires near-saturated DINO before it can be rescued. */
export const DINO_STRONG_RESCUE_FLOOR = 0.20;
/** DINO must be this confident to lift a low CF score into the rescue band. */
export const DINO_STRONG_RESCUE_MIN = 0.96;
/** DINO must be this confident to lift CF in the normal uncertain band. */
export const DINO_RESCUE_MIN = 0.70;
/**
 * Sub-floor tier: below DINO_CF_FLOOR, rescue only when CF is at least
 * faintly awake AND DINO is saturated. CF emits hard zeros on real photos
 * it is certain about, while AI images in its blind spots still elicit a
 * faint response, so "CF flatlined" is itself evidence of a real photo.
 * Bands re-derived for the hard-negative probe (trained with stock,
 * catalog, product, and interior reals) on the Pillow-path bench under a
 * 240-image stress guard; a deliberately conservative near-optimum was
 * chosen over the grid maximum. See PR for the measurement.
 */
export const DINO_SUBFLOOR_CF_MIN = 0.0005;
/** DINO saturation required for the sub-floor rescue. */
export const DINO_SUBFLOOR_MIN = 0.995;
export const URL_HINT_MAX_BOOST = 0.05;

/**
 * CF-primary fusion: CommunityForensics stays authoritative when it is
 * confident (real or AI). DINO only lifts scores where CF is not already
 * near zero, so saturated DINO on stock photos cannot override a
 * confident-real CF score. Below the CF floor a rescue additionally
 * requires CF to be faintly awake (>= DINO_SUBFLOOR_CF_MIN) and DINO to
 * be saturated (>= DINO_SUBFLOOR_MIN).
 * @param {number} cfScore CommunityForensics p(AI) after TTA
 * @param {number|null} dinoScore DINOv2 probe p(AI), null if head unavailable
 * @param {{ graphicGate?: boolean, agreementFallback?: boolean }} [options]
 * @returns {number}
 */
export function fuseNeuralScores(cfScore, dinoScore, options = {}) {
  const cf = clamp01(cfScore);
  if (dinoScore == null || Number.isNaN(dinoScore)) return cf;
  const dino = clamp01(dinoScore);

  if (cf >= DEFAULT_THRESHOLD) return cf;

  if (options.graphicGate) return cf;

  // A disagreed CF spike is weak evidence. After agreement falls back,
  // DINO must be near-saturated to lift again; a 0.76 probe on a 0.40
  // runner-up is the livecdn-121 pattern (Unsplash editorial).
  if (options.agreementFallback && dino < DINO_STRONG_RESCUE_MIN) return cf;

  if (cf < DINO_CF_FLOOR) {
    if (cf >= DINO_SUBFLOOR_CF_MIN && dino >= DINO_SUBFLOOR_MIN) {
      return Math.max(cf, dino);
    }
    return cf;
  }

  // Below the safe band, DINO must be near-saturated to avoid overriding
  // real photos on which CF is only weakly confident.
  if (cf < DINO_STRONG_RESCUE_FLOOR && dino < DINO_STRONG_RESCUE_MIN) return cf;
  if (dino < DINO_RESCUE_MIN) return cf;

  return Math.max(cf, dino);
}

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
