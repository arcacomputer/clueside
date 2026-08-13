/**
 * Neural score mapping for production and eval strategies.
 * Threshold stays raw 0.65 with no UI remapping.
 */

import { DEFAULT_THRESHOLD } from './fuse.js';

export const SOURCE_AI_LABELS = ['stable_diffusion', 'midjourney', 'dalle', 'other_ai'];
export const PRIMARY_MODEL_ID = 'onnx-community/ai-image-detect-distilled-ONNX';
export const HINTS_MODEL_ID = 'onnx-community/ai-source-detector-ONNX';

/**
 * @param {Array<{label: string, score: number}>} outputs
 */
export function parseSourceDetectorOutputs(outputs) {
  if (!outputs?.length) {
    return {
      pReal: 0.5,
      maxAi: 0.5,
      oneMinusReal: 0.5,
      argmax: 'real',
      topScore: 0.5,
    };
  }

  const byLabel = {};
  for (const { label, score } of outputs) {
    byLabel[normalizeLabel(label)] = score;
  }

  const pReal = byLabel.real ?? 0;
  const maxAi = Math.max(...SOURCE_AI_LABELS.map((name) => byLabel[name] ?? 0));
  const argmax = outputs.reduce((best, cur) => (cur.score > best.score ? cur : best));

  return {
    pReal,
    maxAi,
    oneMinusReal: 1 - pReal,
    argmax: normalizeLabel(argmax.label),
    topScore: argmax.score,
  };
}

/**
 * Legacy mapping from PR #1 (inflates spread mass on photographs).
 * @param {Array<{label: string, score: number}>} outputs
 */
export function legacyOneMinusReal(outputs) {
  return parseSourceDetectorOutputs(outputs).oneMinusReal;
}

/**
 * PR #2 mapping (always-real at 0.65 on the 19-image fixture).
 * @param {Array<{label: string, score: number}>} outputs
 */
export function maxAiHeadOnly(outputs) {
  return parseSourceDetectorOutputs(outputs).maxAi;
}

/**
 * Conditional source mapping to measure:
 * - argmax is an AI class -> 1 - p(real)
 * - argmax is real -> max(AI head)
 *
 * @param {Array<{label: string, score: number}>} outputs
 */
export function hybridSourcePAi(outputs) {
  const parsed = parseSourceDetectorOutputs(outputs);

  if (parsed.argmax === 'real') {
    return clamp01(parsed.maxAi);
  }

  if (SOURCE_AI_LABELS.includes(parsed.argmax)) {
    return clamp01(parsed.oneMinusReal);
  }

  return clamp01(parsed.maxAi);
}

/**
 * Primary production mapping: binary distilled fake probability.
 * @param {Array<{label: string, score: number}>} outputs
 */
export function neuralPAiFromDistilled(outputs) {
  if (!outputs?.length) return 0.5;

  const fake = outputs.find((item) => normalizeLabel(item.label) === 'fake');
  if (fake) return clamp01(fake.score);

  const real = outputs.find((item) => normalizeLabel(item.label) === 'real');
  if (real) return clamp01(1 - real.score);

  return clamp01(outputs[0]?.score ?? 0.5);
}

/**
 * @param {'distilled'|'hybrid'|'legacy'|'max_ai'} strategy
 * @param {Array<{label: string, score: number}>|null} primaryOutputs
 * @param {Array<{label: string, score: number}>|null} sourceOutputs
 */
export function neuralPAiForStrategy(strategy, primaryOutputs, sourceOutputs) {
  switch (strategy) {
    case 'legacy':
      return legacyOneMinusReal(sourceOutputs);
    case 'max_ai':
      return maxAiHeadOnly(sourceOutputs);
    case 'hybrid':
      return hybridSourcePAi(sourceOutputs);
    case 'distilled':
    default:
      return neuralPAiFromDistilled(primaryOutputs);
  }
}

/**
 * Production neural score (distilled binary head).
 * @param {Array<{label: string, score: number}>} distilledOutputs
 */
export function neuralPAiFromClassification(distilledOutputs) {
  return neuralPAiFromDistilled(distilledOutputs);
}

/**
 * Optional generator hint from 5-class source detector (never stated as fact).
 * @param {Array<{label: string, score: number}>} outputs
 */
export function topGeneratorHint(outputs) {
  if (!outputs?.length) return null;
  const sorted = [...outputs].sort((a, b) => b.score - a.score);
  for (const item of sorted) {
    const norm = normalizeLabel(item.label);
    if (SOURCE_AI_LABELS.includes(norm) && item.score > 0.2) {
      return norm.replace(/_/g, ' ');
    }
  }
  return null;
}

function normalizeLabel(label) {
  return String(label).toLowerCase().replace(/\s+/g, '_');
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

export { DEFAULT_THRESHOLD };
