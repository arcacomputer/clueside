import { DEFAULT_THRESHOLD } from '../src/fuse.js';
import {
  aggregateProductionViewScores,
  TTA_ADAPTIVE_LOW,
  TTA_EARLY_EXIT,
} from '../src/scoring.js';

export const PRODUCT_VIEW_ORDER = ['center', 'tl', 'tr', 'bl', 'br', 'center_512'];

/**
 * Mirror the extension's fixed production TTA behavior. A reporting threshold
 * supplied to eval/analyze.mjs must not change which views production runs.
 *
 * @param {{views: Record<string, number>}} rec
 * @param {number|null|undefined} dino
 */
export function productCfScore(rec, dino) {
  const center = rec.views.center;
  if (center >= TTA_EARLY_EXIT) return center;

  const runExtra =
    (dino != null && dino >= TTA_ADAPTIVE_LOW) ||
    (center >= TTA_ADAPTIVE_LOW && center < DEFAULT_THRESHOLD);
  if (!runExtra) return center;

  const inspected = [center];
  for (const name of PRODUCT_VIEW_ORDER.slice(1)) {
    const score = rec.views[name];
    if (score == null) continue;
    inspected.push(score);
    if (score >= TTA_EARLY_EXIT) break;
  }
  return aggregateProductionViewScores(inspected);
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
  return Math.max(cf, dino);
}
