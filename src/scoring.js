/**
 * Neural score mapping for the 5-class source detector.
 * Raw scores are NOT remapped to UI percent. Eval threshold stays 0.65.
 */

import { DEFAULT_THRESHOLD } from './fuse.js';

export const SOURCE_AI_LABELS = ['stable_diffusion', 'midjourney', 'dalle', 'other_ai'];

/**
 * @param {Array<{label: string, score: number}>} outputs
 */
export function parseSourceDetectorOutputs(outputs) {
  if (!outputs?.length) {
    return {
      pReal: 0.5,
      maxAi: 0.5,
      sumAi: 0.5,
      oneMinusReal: 0.5,
      argmax: 'real',
      topScore: 0.5,
      topAiLabel: null,
    };
  }

  const byLabel = {};
  for (const { label, score } of outputs) {
    byLabel[normalizeLabel(label)] = score;
  }

  const pReal = byLabel.real ?? 0;
  const aiEntries = SOURCE_AI_LABELS.map((name) => ({
    name,
    score: byLabel[name] ?? 0,
  }));
  const maxAiEntry = aiEntries.reduce((best, cur) => (cur.score > best.score ? cur : best));
  const maxAi = maxAiEntry.score;
  const sumAi = aiEntries.reduce((sum, item) => sum + item.score, 0);

  const argmax = outputs.reduce((best, cur) => (cur.score > best.score ? cur : best));
  const argmaxNorm = normalizeLabel(argmax.label);

  return {
    pReal,
    maxAi,
    sumAi,
    oneMinusReal: 1 - pReal,
    argmax: argmaxNorm,
    topScore: argmax.score,
    topAiLabel: maxAiEntry.name,
  };
}

/**
 * Map 5-class source-detector softmax to raw p(AI).
 *
 * Do NOT use 1 - p(real): residual mass on four AI heads inflates p(AI) for
 * ordinary photographs when probability is spread across generator classes.
 *
 * Rules:
 * - argmax real: p(AI) = max AI head probability
 * - argmax AI class: p(AI) = that class score
 * - borderline AI argmax (0.55-0.64): allow modest lift from total AI mass
 *
 * @param {Array<{label: string, score: number}>} outputs
 */
export function neuralPAiFromSourceDetector(outputs) {
  const parsed = parseSourceDetectorOutputs(outputs);

  if (parsed.argmax === 'real') {
    return clamp01(parsed.maxAi);
  }

  if (SOURCE_AI_LABELS.includes(parsed.argmax)) {
    let score = parsed.topScore;
    if (score < DEFAULT_THRESHOLD && score >= 0.55) {
      const lifted = parsed.topScore + (parsed.sumAi - parsed.topScore) * 0.35;
      score = Math.max(score, lifted);
    }
    return clamp01(score);
  }

  return clamp01(parsed.maxAi);
}

/**
 * @param {Array<{label: string, score: number}>} sourceOutputs
 * @param {Array<{label: string, score: number}>|null} [_binaryOutputs]
 */
export function ensembleNeuralPAi(sourceOutputs, _binaryOutputs = null) {
  return neuralPAiFromSourceDetector(sourceOutputs);
}

/**
 * @param {Array<{label: string, score: number}>} outputs
 */
export function neuralPAiFromBinary(outputs) {
  if (!outputs?.length) return 0.5;

  const fake = outputs.find((item) => normalizeLabel(item.label) === 'fake');
  if (fake) return clamp01(fake.score);

  const real = outputs.find((item) => normalizeLabel(item.label) === 'real');
  if (real) return clamp01(1 - real.score);

  return clamp01(outputs[0]?.score ?? 0.5);
}

/**
 * Legacy mapping kept for eval comparison scripts only.
 * @param {Array<{label: string, score: number}>} outputs
 */
export function legacyOneMinusReal(outputs) {
  return parseSourceDetectorOutputs(outputs).oneMinusReal;
}

/**
 * Optional generator class hint from top non-real label (never stated as fact).
 * @param {Array<{label: string, score: number}>} outputs
 */
export function topGeneratorHint(outputs) {
  const sorted = [...(outputs || [])].sort((a, b) => b.score - a.score);
  for (const item of sorted) {
    const norm = normalizeLabel(item.label);
    if (SOURCE_AI_LABELS.includes(norm) && item.score > 0.2) {
      return norm.replace(/_/g, ' ');
    }
  }
  return null;
}

/** @deprecated Use neuralPAiFromSourceDetector */
export function neuralPAiFromClassification(outputs) {
  return neuralPAiFromSourceDetector(outputs);
}

function normalizeLabel(label) {
  return String(label).toLowerCase().replace(/\s+/g, '_');
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}
