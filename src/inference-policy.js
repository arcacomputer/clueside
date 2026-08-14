import { DEFAULT_THRESHOLD, fuseNeuralScores, fuseScores } from './fuse.js';
import { TTA_ADAPTIVE_LOW } from './scoring.js';

/**
 * A suspicious DINO pass makes adaptive CommunityForensics scoring inspect all
 * views. Explicit center/always choices remain unchanged.
 * @param {'adaptive'|'always'|'center'} requestedMode
 * @param {number|null} dinoPAi
 */
export function effectiveTtaMode(requestedMode, dinoPAi) {
  const dinoSuspicious = dinoPAi != null && dinoPAi >= TTA_ADAPTIVE_LOW;
  return requestedMode === 'adaptive' && dinoSuspicious ? 'always' : requestedMode;
}

/**
 * The single production scoring policy shared by the extension and evaluators.
 * @param {number} cfPAi
 * @param {number|null} dinoPAi
 * @param {import('./fuse.js').HeuristicSignals} heuristics
 * @param {number} [threshold]
 */
export function fuseInferenceScores(
  cfPAi,
  dinoPAi,
  heuristics,
  threshold = DEFAULT_THRESHOLD
) {
  return fuseScores(fuseNeuralScores(cfPAi, dinoPAi), heuristics, threshold);
}
