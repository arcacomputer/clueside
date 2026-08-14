/**
 * Decide whether an asynchronous page-image analysis still belongs to
 * what the user is currently seeing. Lazy loaders and virtualized grids
 * can replace an image while an older request is waiting in the queue.
 *
 * Kept DOM-free so the race policy is covered by ordinary unit tests.
 *
 * @param {{ url: string, source: 'img'|'background', generation: number }} job
 * @param {{
 *   enabled: boolean,
 *   autoScan: boolean,
 *   connected: boolean,
 *   generation: number,
 *   currentUrl?: string,
 *   backgroundUrls?: string[],
 * }} state
 */
export function isAnalyzeJobCurrent(job, state) {
  if (!job || !state.enabled || !state.autoScan || !state.connected) return false;
  if (job.generation !== state.generation) return false;

  if (job.source === 'img') {
    return Boolean(job.url) && state.currentUrl === job.url;
  }

  if (job.source === 'background') {
    return Boolean(job.url) && (state.backgroundUrls || []).includes(job.url);
  }

  return false;
}
