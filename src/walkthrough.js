export const WALKTHROUGH_STORAGE_KEY = 'walkthroughDismissed';

export const WALKTHROUGH_TITLE = 'How to use';

export const WALKTHROUGH_STEPS = [
  'Pin the toolbar icon (Chrome puzzle menu, then the pin).',
  'Reload the page you are on.',
  'Wait for red AI or green OK badges on large images.',
];

export const WALKTHROUGH_DROP_HINT =
  'Optional: drop one image below to check a single file.';

export const WALKTHROUGH_DISMISS_LABEL = 'Got it';

/**
 * First-run card shows until the user dismisses it once.
 * @param {Record<string, unknown>} stored
 */
export function shouldShowWalkthrough(stored = {}) {
  return stored[WALKTHROUGH_STORAGE_KEY] !== true;
}
