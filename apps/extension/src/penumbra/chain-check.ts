/**
 * The chain-id check for Penumbra services that started on a stored chain id.
 *
 * Their sync is held until the node confirms the id. A changed id rebuilds the
 * services; a confirmed one releases the hold. A node that does not answer in
 * time (see CHAIN_CHECK_TIMEOUT_MS) releases it too - sync goes on as it would
 * have - but the check stays armed: it is asked again a little later while a
 * window is open, and on the next window that opens. Nothing here calls out
 * with every window closed unless the user asked Penumbra to keep syncing
 * (the caller decides when to `run`).
 */

export interface ChainCheckDeps {
  /** some zafu window is open */
  windowOpen: () => boolean;
  /** the node's chain id, or undefined when it did not answer in time */
  refresh: () => Promise<string | undefined>;
  /** the node serves another chain: rebuild the services for it */
  rebuild: (why: string) => void;
  /** wait before asking again after no answer */
  retryMs: number;
}

export const createChainCheck = (deps: ChainCheckDeps) => {
  let pending: (() => Promise<void>) | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  /** bumped whenever the services change; an older check's answer is moot */
  let generation = 0;

  const run = () => {
    clearTimeout(retry);
    retry = undefined;
    const check = pending;
    pending = undefined;
    void check?.();
  };

  return {
    /** fresh services on a stored chain id: `release` lets their sync go on */
    arm: (chainId: string, release: () => void) => {
      const mine = ++generation;
      clearTimeout(retry);
      const check = async (): Promise<void> => {
        const node = await deps.refresh().catch(() => undefined);
        if (mine !== generation) {
          return;
        }
        if (node && node !== chainId) {
          // the refresh stored the node's params, so the rebuild reads the new
          // chain; this processor stays held until the rebuild stops it
          console.warn(`[sync] the node serves ${node}, not ${chainId}; rebuilding`);
          deps.rebuild('chain id changed');
          return;
        }
        release();
        if (node === undefined) {
          // not confirmed: ask again, but only while someone is looking
          pending = check;
          retry = setTimeout(() => {
            if (mine === generation && deps.windowOpen()) {
              run();
            }
          }, deps.retryMs);
        }
      };
      pending = check;
    },
    /** the services changed (rebuilt, or started confirmed): nothing to ask */
    drop: () => {
      generation++;
      pending = undefined;
      clearTimeout(retry);
      retry = undefined;
    },
    /** ask now, if a check is armed */
    run,
  };
};
