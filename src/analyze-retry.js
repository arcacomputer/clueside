/**
 * First-load analyze retries. Offscreen JS (onnxruntime bundle) can still
 * be evaluating when the first gallery images fire.
 *
 * FETCH_TIMEOUT_MS applies only after that image's fetch starts.
 * INFERENCE_TIMEOUT_MS applies only after that image's ORT run starts.
 * Waiting in the page queue must not use either clock.
 */

export const FETCH_TIMEOUT_MS = 8000;
export const INFERENCE_TIMEOUT_MS = 45_000;

/**
 * Safety net around sendMessage after a job is dequeued. Long enough for
 * a sibling job to finish a 45s inference plus this image's own run.
 * Not used while the badge is only waiting in the queue.
 */
export const AFTER_START_SAFETY_MS = 180_000;

/** @deprecated Fetch budget only. Do not use as a queue-wait timeout. */
export const ANALYZE_TIMEOUT_MS = FETCH_TIMEOUT_MS;

export function isFetchSkipError(error) {
  const msg = String(error || '').toLowerCase();
  return (
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('cors') ||
    msg.includes('image fetch failed') ||
    msg.includes('image fetch timed out') ||
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
  if (msg.includes('inference timed out')) return false;
  if (msg === 'timed out') return false;

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
 * Cap a run that has already started. Resolves with { error } on timeout.
 * Do not wrap queue wait with this helper.
 * @param {() => Promise<object>} run
 * @param {{ timeoutMs?: number, timeoutMessage?: string }} [options]
 */
export async function withAnalyzeDeadline(run, options = {}) {
  const ms = options.timeoutMs ?? AFTER_START_SAFETY_MS;
  const timeoutMessage = options.timeoutMessage ?? 'Inference timed out';

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

/**
 * Reject-style deadline for fetch / other promises that throw.
 * @param {Promise<unknown>|(() => Promise<unknown>)} work
 * @param {number} ms
 * @param {string} message
 */
export async function withTimeout(work, ms, message) {
  const promise = typeof work === 'function' ? Promise.resolve().then(work) : Promise.resolve(work);
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function toSkipResult(error) {
  const reason = String(error || 'Fetch blocked');
  return { skipped: true, reason };
}
