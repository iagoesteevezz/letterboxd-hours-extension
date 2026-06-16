// --------------------------------------------------------------------------
// Rate limiting + concurrency control.
//
// Letterboxd has no public API, so we scrape. To stay polite (and to avoid
// getting our IP throttled/blocked) we never fire all requests at once:
//
//   * `concurrency` caps how many requests are in flight simultaneously.
//   * `delayMs` spaces out the *start* of each task, so even within the
//     concurrency budget we trickle requests instead of bursting.
//
// This is the single most important "don't hammer the server" primitive in
// the whole extension, so it lives in its own well-commented module.
// --------------------------------------------------------------------------

export interface PoolOptions {
  /** Max simultaneous in-flight tasks. Keep small (3-5). */
  concurrency: number;
  /** Minimum gap between starting two tasks, in ms. */
  delayMs: number;
  /** Called after each task settles, for progress UI. */
  onProgress?: (done: number, total: number) => void;
  /** Optional abort signal to stop early. */
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs `worker` over every item with bounded concurrency and a throttle delay.
 * Results are returned in the SAME order as `items`. Individual failures resolve
 * to `undefined` (we never want one dead film page to kill the whole run).
 */
export async function runPool<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  opts: PoolOptions
): Promise<(R | undefined)[]> {
  const { concurrency, delayMs, onProgress, signal } = opts;
  const results: (R | undefined)[] = new Array(items.length);
  let nextIndex = 0;
  let done = 0;

  // Each "runner" is a worker that pulls the next index off the shared counter,
  // waits the throttle delay, processes it, then loops. We launch `concurrency`
  // runners; together they drain the queue without ever exceeding the budget.
  async function runner() {
    while (true) {
      if (signal?.aborted) return;
      const i = nextIndex++;
      if (i >= items.length) return;

      // Throttle: stagger task starts so we don't burst the server.
      if (delayMs > 0) await sleep(delayMs);

      try {
        results[i] = await worker(items[i], i);
      } catch {
        results[i] = undefined; // swallow per-item errors; keep the run alive
      } finally {
        done++;
        onProgress?.(done, items.length);
      }
    }
  }

  const runners = Array.from({ length: Math.max(1, concurrency) }, () => runner());
  await Promise.all(runners);
  return results;
}
