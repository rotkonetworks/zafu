/**
 * One sync run per wallet, never two. Two loops on one wallet both advance
 * the same tree and witnesses, so the frontier they leave disagrees with the
 * stored height and the next start rebootstraps and drops every witness.
 */

export interface RunSlot {
  /** aborts the run that owns the wallet now */
  stop?: AbortController;
  /** that run, settled once it has fully ended; never rejects */
  run?: Promise<void>;
}

/** how long a stop waits on a run wedged in a fetch that ignores the abort */
export const STOP_WAIT_MS = 15_000;

/**
 * Abort the slot's run and wait until it has ended. A run still wedged after
 * the wait can apply nothing more: its own signal stays aborted.
 */
export const stopRun = async (slot: RunSlot, waitMs = STOP_WAIT_MS): Promise<void> => {
  slot.stop?.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([slot.run, new Promise(resolve => (timer = setTimeout(resolve, waitMs)))]);
  clearTimeout(timer);
};

/**
 * Start a run that owns the wallet from this moment: a stop that lands while
 * it waits for the run before it, or while it is still starting, ends it.
 * `ended` is called only while it is still the slot's latest run, so a run
 * another one replaced never reports the wallet idle under its successor.
 */
export const startRun = (
  slot: RunSlot,
  body: (signal: AbortSignal) => Promise<void>,
  ended: () => void,
  waitMs = STOP_WAIT_MS,
): Promise<void> => {
  const before = stopRun(slot, waitMs);
  const stop = new AbortController();
  slot.stop = stop;
  const run = before
    .then(() => (stop.signal.aborted ? undefined : body(stop.signal)))
    .catch(() => undefined)
    .then(() => {
      if (slot.stop === stop) {
        ended();
      }
    });
  slot.run = run;
  return run;
};
