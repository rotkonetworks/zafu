/**
 * Was the zcash store wiped under a running sync?
 *
 * The worker forgets a connection the browser closes and opens a fresh one
 * on the next call (zcash-worker.ts getDb). If the database itself was
 * deleted or cleared, that fresh connection opens an EMPTY store, and a loop
 * that went on from its in-memory height would write that height into it:
 * every block below it, and every note in those blocks, silently skipped.
 *
 * So after a reconnect the loop compares the store with what it last saved.
 * Missing wallet record, or a stored height below the last one this run
 * wrote, means the store is not the one it was writing: stop the run and
 * start again from what is stored (or the wallet's birthday when nothing is).
 */
export const storeFellBehind = (s: {
  /** the stored sync height (0 when none is stored) */
  stored: number;
  /** the wallet's record is still in the registry */
  walletKnown: boolean;
  /** the last height this run saved (or found stored when it started) */
  lastSaved: number;
}): boolean => !s.walletKnown || s.stored < s.lastSaved;
