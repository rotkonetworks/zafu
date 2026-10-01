import { useEffect, useState, useSyncExternalStore } from 'react';

/** the worker's own estimate for a full witness rebuild (zcash-worker.ts) */
export const REBUILD_MS = 3 * 60_000;

/**
 * When the running witness rebuild began, read off the worker's send-progress
 * labels: "witness corrupt" starts it, its "backfill:" sub-steps continue it,
 * and any other label means the build moved on (or a new one started).
 */
export const rebuildSince = (prev: number | undefined, step: string, now: number) =>
  step.startsWith('witness corrupt')
    ? (prev ?? now)
    : step.startsWith('backfill:')
      ? prev
      : undefined;

/** what is left of the estimate, never a number the worker did not give */
export const rebuildLeft = (since: number, now: number): string => {
  const min = Math.ceil((REBUILD_MS - (now - since)) / 60_000);
  return min > 0 ? `about ${min} min left` : 'a little longer';
};

let since: number | undefined;
const listeners = new Set<() => void>();

// one listener for the realm, so a rebuild begun on the send screen is still
// known after the person goes back home
if (typeof window !== 'undefined') {
  window.addEventListener('zcash-send-progress', e => {
    const step = (e as CustomEvent<{ step?: unknown }>).detail?.step;
    const next = typeof step === 'string' ? rebuildSince(since, step, Date.now()) : since;
    if (next !== since) {
      since = next;
      listeners.forEach(l => l());
    }
  });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** the start of the witness rebuild in progress, or undefined */
export const useRebuildSince = () => useSyncExternalStore(subscribe, () => since);

/** the estimate left on the running rebuild, re-read every few seconds */
export const useRebuildLeft = (start: number | undefined) => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (start === undefined) {
      return;
    }
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [start]);
  return start === undefined ? undefined : rebuildLeft(start, now);
};
