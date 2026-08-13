/**
 * First-load analyze retries. Offscreen JS (onnxruntime bundle) can still
 * be evaluating when the first gallery images fire.
 */

export const ANALYZE_TIMEOUT_MS = 8000;

export function isFetchSkipError(error) {
  const msg = String(error || '').toLowerCase();
  return (
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('cors') ||
    msg.includes('image fetch failed') ||
    msg.includes('not an image content-type') ||
    msg.includes('load failed') ||
    msg.includes('err_failed') ||
    msg.includes('err_blocked')
  );
}

export function isTransientAnalyzeError(error) {
  const msg = String(error || '').toLowerCase();
  if (!msg) return true;
  if (isFetchSkipError(msg)) return false;

  return (
    msg.includes('buffer') ||
    msg.includes('undefined') ||
    msg.includes('receiving end') ||
    msg.includes('could not establish connection') ||
    msg.includes('no image bytes') ||
    msg.includes('offscreen analysis failed') ||
    msg.includes('offscreen listener') ||
    msg.includes('not ready') ||
    msg.includes('no response') ||
    msg.includes('session')
  );
}

export function backoffMs(attempt) {
  return Math.min(2000, 150 * 2 ** attempt);
}

export async function withRetries(run, options = {}) {
  const attempts = options.attempts ?? 8;
  const sleepFn = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    last = await run(attempt);
    if (!last?.error) return last;
    if (last.skipped) return last;
    if (!isTransientAnalyzeError(last.error)) return last;
    if (attempt < attempts - 1) {
      await sleepFn(backoffMs(attempt));
    }
  }
  return last;
}

/**
 * Cap pending `...` badges. Resolves with { error } on timeout so the
 * overlay never stays on infinite dots.
 * @param {() => Promise<object>} run
 * @param {{ timeoutMs?: number, timeoutMessage?: string }} [options]
 */
export async function withAnalyzeDeadline(run, options = {}) {
  const ms = options.timeoutMs ?? ANALYZE_TIMEOUT_MS;
  const timeoutMessage = options.timeoutMessage ?? 'Timed out';

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ error: timeoutMessage }), ms);
  });

  try {
    return await Promise.race([Promise.resolve().then(run), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function toSkipResult(error) {
  const reason = String(error || 'Fetch blocked');
  return { skipped: true, reason };
}
