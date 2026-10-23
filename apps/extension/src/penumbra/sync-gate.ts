/**
 * A Penumbra transaction planned before the wallet has scanned to the tip can
 * pick notes that a recent transaction already spent; the chain then rejects
 * it ("nullifier ... was already spent"). Wait for the scan to reach the tip
 * before planning, and refuse if it does not get there.
 */

export interface SyncStatus {
  catchingUp: boolean;
  fullSyncHeight: bigint;
}

const POLL_MS = 1_500;
export const SYNC_WAIT_MS = 3 * 60_000;

/**
 * Resolve once the view service says it is not catching up. Polled, because
 * the scanner trails each new block by a moment: a single read just after a
 * block lands says "catching up" for a wallet that is in fact current.
 * Calls `onWaiting` once if it has to wait.
 */
export const waitForSync = async ({
  status,
  onWaiting,
  waitMs = SYNC_WAIT_MS,
  pollMs = POLL_MS,
  now = Date.now,
  sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms)),
}: {
  status: () => Promise<SyncStatus>;
  onWaiting?: (height: bigint) => void | Promise<void>;
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> => {
  const deadline = now() + waitMs;
  let told = false;
  for (;;) {
    const s = await status();
    if (!s.catchingUp) {
      return;
    }
    if (!told) {
      told = true;
      await onWaiting?.(s.fullSyncHeight);
    }
    if (now() >= deadline) {
      throw new Error(
        `the wallet is still syncing (at block ${s.fullSyncHeight}) · nothing was sent, try again once it is up to date`,
      );
    }
    await sleep(pollMs);
  }
};
