/**
 * First-load analyze retries. Offscreen JS (onnxruntime bundle) can still
 * be evaluating when the first gallery images fire.
 */

export function isTransientAnalyzeError(error) {
  const msg = String(error || '').toLowerCase();
  if (!msg) return true;

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
    if (attempt > 0 && !isTransientAnalyzeError(last.error)) return last;
    if (attempt < attempts - 1) {
      await sleepFn(backoffMs(attempt));
    }
  }
  return last;
}
