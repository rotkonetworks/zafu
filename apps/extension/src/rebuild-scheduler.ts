/**
 * Serialized, coalescing, skip-if-unchanged scheduler for rebuilding the
 * penumbra wallet services.
 *
 * A rebuild is expensive (restarts sync, reloads the whole state-commitment
 * tree into wasm, re-fetches genesis) and must never overlap another: two
 * overlapping rebuilds both stopped the same old block processor and each
 * started a new one, leaving an orphan syncing the same IndexedDB.
 *
 * - Rebuilds run strictly one at a time.
 * - Requests arriving while one is PENDING (queued, not yet started) fold into
 *   it; the target is read when it runs, so it reflects the latest state.
 * - Nothing happens if the desired target equals the running one.
 */
export interface RebuildScheduler<T> {
  request: (why: string) => Promise<void>;
  /** record what is running without rebuilding (e.g. the boot services) */
  setRunning: (target: T) => void;
  getRunning: () => T | undefined;
}

export const createRebuildScheduler = <T>(deps: {
  desired: () => Promise<T>;
  same: (a: T, b: T) => boolean;
  rebuild: (target: T, previous: T | undefined, why: string) => Promise<void>;
  onError?: (e: unknown) => void;
}): RebuildScheduler<T> => {
  let running: T | undefined;
  let chain: Promise<void> = Promise.resolve();
  let pending = false;

  const request = (why: string): Promise<void> => {
    if (pending) {
      return chain;
    }
    pending = true;
    chain = chain
      .then(async () => {
        pending = false;
        const target = await deps.desired();
        if (running !== undefined && deps.same(running, target)) {
          return;
        }
        const previous = running;
        running = target;
        await deps.rebuild(target, previous, why);
      })
      .catch((e: unknown) => {
        deps.onError?.(e);
      });
    return chain;
  };

  return {
    request,
    setRunning: target => {
      running = target;
    },
    getRunning: () => running,
  };
};
