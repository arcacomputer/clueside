export const WALKTHROUGH_STORAGE_KEY = 'walkthroughDismissed';

export const WALKTHROUGH_TITLE = 'How to use';

export const WALKTHROUGH_STEPS = [
  'Pin the toolbar icon (Chrome puzzle, then pin).',
  'Reload the tab you are on.',
  'Wait for badges on large images (green OK or red AI).',
];

export const WALKTHROUGH_DROP_HINT =
  'Optional: drop a file in the popup to check one image.';

export const WALKTHROUGH_DISMISS_LABEL = 'Got it';

export const LEGEND_ITEMS = [
  { badge: 'AI', tone: 'ai', label: 'likely generated' },
  { badge: 'OK', tone: 'ok', label: 'likely a real photo' },
  { badge: '?', tone: 'uncertain', label: 'not sure' },
  { badge: 'skip', tone: 'skip', label: 'could not read that image' },
];

export const LEGEND_HELP =
  'Percentage is p(AI). We label AI at 65% or higher. Analysis stays on this device.';

export const DROP_ZONE_LABEL = 'Check one image';

/**
 * First-run card shows until the user dismisses it once.
 * @param {Record<string, unknown>} stored
 */
export function shouldShowWalkthrough(stored = {}) {
  return stored[WALKTHROUGH_STORAGE_KEY] !== true;
}
