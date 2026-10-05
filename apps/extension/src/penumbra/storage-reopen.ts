/**
 * Penumbra's database connection died under the block processor (the browser
 * closed it, or the backing store failed): build the services again, which
 * opens a fresh connection, a few times with a growing wait. A full disk or a
 * database from a newer build cannot be fixed by a new connection, nor can a
 * fourth failure in a row: sync then stops, and the person is told (the home
 * sync strip says so, with a reload). Nothing is rebuilt while every window
 * is closed; the next window to open does it.
 *
 * The budget is for failures in a row: once a reopened processor stores a
 * block past where the last failure stood, it is whole again.
 */

export interface StorageReopenDeps {
  /** build the services again (a fresh connection) */
  reopen: () => void;
  /** a window is open, or penumbra keeps syncing with every window closed */
  mayReopen: () => boolean;
  /** 'fatal' for a failure a new connection cannot fix */
  kind: (e: unknown) => 'reopen' | 'fatal' | undefined;
  /** sync stopped for good: tell the person */
  stopped: (e: unknown) => void;
  /** the stored sync height now, if known */
  height: () => Promise<number | undefined>;
  wait?: (fn: () => void, ms: number) => void;
  log?: { warn: (m: string) => void; error: (m: string) => void };
}

export const STORAGE_REOPEN_MAX = 3;

export const createStorageReopen = (deps: StorageReopenDeps) => {
  const wait = deps.wait ?? ((fn, ms) => void setTimeout(fn, ms));
  const log = deps.log ?? console;
  let tries = 0;
  let waiting = false;
  /** the stored height when the last failure happened */
  let failedAt: number | undefined;
  const reopen = () => {
    waiting = false;
    deps.reopen();
  };
  const text = (e: unknown) => (e instanceof Error ? e.message : String(e));
  return {
    failed: (e: unknown) => {
      void deps.height().then(
        h => (failedAt = h),
        () => undefined,
      );
      if (deps.kind(e) === 'fatal' || tries >= STORAGE_REOPEN_MAX) {
        log.error(
          `[sync] penumbra sync stopped: local data could not be read or written (${text(e)}). reload zafu to try again`,
        );
        deps.stopped(e);
        return;
      }
      tries++;
      const ms = 5_000 * 2 ** (tries - 1);
      log.warn(`[sync] penumbra storage closed (${text(e)}); reopening in ${ms / 1000}s`);
      waiting = true;
      // a window that opened during the wait already reopened it (onOpen)
      wait(() => {
        if (waiting && deps.mayReopen()) {
          reopen();
        }
      }, ms);
    },
    /** a window opened: a reopen held back while every window was closed goes now */
    onOpen: () => {
      if (waiting) {
        reopen();
      }
    },
    /** the stored height moved: a processor past the last failure refills the budget */
    progressed: (height: number) => {
      if (tries > 0 && failedAt !== undefined && height > failedAt) {
        tries = 0;
        failedAt = undefined;
      }
    },
    /** for tests */
    get tries() {
      return tries;
    },
  };
};
