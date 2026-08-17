/**
 * Page-scan analyze scheduling. WASM (and even WebGPU) cannot score a
 * masonry of dozens of images in parallel. Two in flight, TTA shed under
 * load, clocks start when that image's work starts (not when the badge
 * is painted).
 */

export const ANALYZE_CONCURRENCY = 2;

/**
 * Historical load-shed cutoff. Adaptive already skips extras on confident
 * reals (center < 0.15), so shedding to center-only only changed behavior
 * when the center crop was suspicious: exactly the band where live CDN
 * photos need extras for the agreement rule. Kept as a named constant so
 * older tests and comments stay searchable; production no longer sheds.
 */
export const TTA_SKIP_WHEN_PENDING_ABOVE = 12;

/**
 * Always adaptive. A busy Unsplash masonry (26+ badges) used to force
 * center-only on the first ~14 images, which disabled view agreement and
 * let a lone 0.81-0.94 center crop become the AI verdict. Adaptive already
 * costs two passes on confident reals; extras run only when a head is
 * suspicious.
 * @param {number} [_pendingCount]
 */
export function ttaModeForLoad(_pendingCount) {
  return 'adaptive';
}

export function normalizeTtaMode(mode) {
  if (mode === 'center' || mode === 'always' || mode === 'adaptive') return mode;
  return 'adaptive';
}

/**
 * @param {{
 *   concurrency?: number,
 *   run: (item: unknown, meta: { pendingCount: number, ttaMode: string }) => Promise<unknown>,
 * }} options
 */
export function createAnalyzeQueue({ concurrency = ANALYZE_CONCURRENCY, run } = {}) {
  if (typeof run !== 'function') {
    throw new Error('createAnalyzeQueue requires run');
  }

  const waiting = [];
  let active = 0;
  let pumpScheduled = false;

  // Defer the first start so a synchronous gallery scan (querySelectorAll
  // + enqueue) is visible as one pending pile. Starting immediately on the
  // first enqueue would treat that image as a short queue and run TTA.

  function pump() {
    while (active < concurrency && waiting.length > 0) {
      const job = waiting.shift();
      active += 1;
      const pendingCount = waiting.length + active;
      const ttaMode = ttaModeForLoad(pendingCount);
      Promise.resolve()
        .then(() => run(job.item, { pendingCount, ttaMode }))
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          schedulePump();
        });
    }
  }

  function schedulePump() {
    if (pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      pump();
    });
  }

  return {
    enqueue(item) {
      return new Promise((resolve, reject) => {
        waiting.push({ item, resolve, reject });
        schedulePump();
      });
    },
    stats() {
      return {
        waiting: waiting.length,
        active,
        pending: waiting.length + active,
      };
    },
  };
}

/**
 * Serialize a critical section (ORT session.run) so two in-flight page
 * jobs cannot overlap WASM inference.
 */
export function createExclusiveLock() {
  let tail = Promise.resolve();

  return {
    run(fn) {
      const next = tail.then(fn, fn);
      tail = next.then(
        () => undefined,
        () => undefined
      );
      return next;
    },
  };
}

/**
 * Start `timeoutMs` only after `lock` is acquired. A waiter does not burn
 * the inference budget while another image is still inside ORT.
 *
 * If the timer fires, the caller is rejected immediately. The lock stays
 * held until `workFn` settles so the next session.run cannot overlap.
 *
 * @param {{ run: (fn: () => Promise<unknown>) => Promise<unknown> }} lock
 * @param {() => Promise<unknown>} workFn
 * @param {number} timeoutMs
 * @param {string} timeoutMessage
 */
export function runExclusiveAfterStart(lock, workFn, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    lock
      .run(async () => {
        let settled = false;
        const work = Promise.resolve().then(workFn);
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error(timeoutMessage));
          }
        }, timeoutMs);
        try {
          const value = await work;
          if (!settled) {
            settled = true;
            resolve(value);
          }
        } catch (err) {
          if (!settled) {
            settled = true;
            reject(err);
          }
        } finally {
          clearTimeout(timer);
        }
      })
      .catch((err) => {
        reject(err);
      });
  });
}
