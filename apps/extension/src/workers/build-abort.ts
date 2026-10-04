/**
 * Stopping a transaction build that is still running in the worker.
 *
 * A build registers under a key its page chose (the tracker's opId), so any
 * window can stop it later, even after the page that started it has closed.
 * Every awaited phase before the broadcast races the stop, so a wedged fetch or
 * a queued prove ends at once; whatever it returns later is dropped. The line
 * before the broadcast is the point of no return: from there a stop is refused
 * and the page says the payment is already on its way.
 *
 * Nothing is reserved before a broadcast (inputs are marked spent only once the
 * network has the transaction), so a stopped build leaves nothing behind.
 */

export const BUILD_STOPPED = 'this send was stopped before it left';

export class BuildStopped extends Error {
  constructor() {
    super(BUILD_STOPPED);
    this.name = 'BuildStopped';
  }
}

export const isBuildStopped = (e: unknown): boolean =>
  e instanceof BuildStopped || (e instanceof Error && e.message === BUILD_STOPPED);

/**
 * What a stop found:
 * - stopped: the build was running (or not yet started) and will not broadcast
 * - committed: it reached the broadcast, so it may be on its way
 * - ended: it had already ended before the broadcast (failed, or a cold build
 *   handed back to its page), so there is nothing to stop and nothing was sent
 */
export type StopOutcome = 'stopped' | 'committed' | 'ended';

interface Entry {
  ac: AbortController;
  committed: boolean;
}

/** how many ended or pre-stopped keys are remembered */
const REMEMBER = 32;

export interface BuildHandle {
  readonly signal: AbortSignal;
  /** throw if a stop has landed */
  check: () => void;
  /** await `p` unless a stop lands first */
  race: <T>(p: Promise<T>) => Promise<T>;
  /** the point of no return: throws if stopped, else refuses every later stop */
  commit: () => void;
}

export const createBuildRegistry = () => {
  const running = new Map<string, Entry>();
  /** key -> how it ended; a key stopped before it arrived is 'stopped' */
  const ended = new Map<string, 'committed' | 'ended' | 'stopped'>();

  const remember = (key: string, how: 'committed' | 'ended' | 'stopped') => {
    ended.delete(key);
    ended.set(key, how);
    while (ended.size > REMEMBER) {
      ended.delete(ended.keys().next().value!);
    }
  };

  const begin = (key?: string): BuildHandle => {
    const ac = new AbortController();
    const entry: Entry = { ac, committed: false };
    if (key) {
      if (ended.get(key) === 'stopped') {
        // the stop reached the worker before the build did
        ac.abort();
      }
      running.set(key, entry);
    }
    const check = () => {
      if (ac.signal.aborted) {
        throw new BuildStopped();
      }
    };
    const race = <T>(p: Promise<T>): Promise<T> => {
      if (ac.signal.aborted) {
        // the dropped work may still fail later; that is no longer anyone's error
        p.catch(() => undefined);
        return Promise.reject(new BuildStopped());
      }
      return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          p.catch(() => undefined);
          reject(new BuildStopped());
        };
        ac.signal.addEventListener('abort', onAbort, { once: true });
        p.then(resolve, reject).finally(() => ac.signal.removeEventListener('abort', onAbort));
      });
    };
    return {
      signal: ac.signal,
      check,
      race,
      commit: () => {
        check();
        entry.committed = true;
      },
    };
  };

  /** the build under `key` ended, however it ended; safe to call more than once */
  const end = (key: string) => {
    const entry = running.get(key);
    if (entry) {
      running.delete(key);
      // past the point of no return it may be on chain, whatever came back
      remember(key, entry.committed ? 'committed' : entry.ac.signal.aborted ? 'stopped' : 'ended');
    }
  };

  const stop = (key: string): StopOutcome => {
    const entry = running.get(key);
    if (entry) {
      if (entry.committed) {
        return 'committed';
      }
      entry.ac.abort();
      return 'stopped';
    }
    const how = ended.get(key);
    if (how === 'committed' || how === 'ended') {
      return how;
    }
    remember(key, 'stopped');
    return 'stopped';
  };

  return { begin, stop, end };
};
