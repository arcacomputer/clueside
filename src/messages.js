const BACKGROUND_MESSAGE_TYPES = new Set([
  'analyze-url',
  'analyze-buffer',
  'get-settings',
  'set-settings',
  'warmup',
  'check-update',
  'get-update-status',
  'dismiss-update',
]);

/**
 * Runtime messages are delivered to every extension frame. The service
 * worker must decline offscreen-targeted and unknown messages instead of
 * keeping an async response channel open that it will never answer.
 *
 * @param {unknown} message
 */
export function isBackgroundMessage(message) {
  return Boolean(
    message &&
      typeof message === 'object' &&
      message.target !== 'offscreen' &&
      BACKGROUND_MESSAGE_TYPES.has(message.type)
  );
}
