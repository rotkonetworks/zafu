/**
 * Is a build still moving? Read off the worker's progress labels and real
 * time only: each phase has its own sense of "quiet for too long", and a
 * phase that goes far past it ends the build instead of leaving it to spin.
 *
 * The proving ticker ("proving (halo2) 12s elapsed") is a heartbeat from the
 * worker, not progress from the prover: a prove queued behind another build
 * ticks just the same. So it never resets the clock; the host's own bound on a
 * prove (offscreen-handler PARALLEL_BUILD_TIMEOUT_MS, 5 min) sets the limit.
 */

import { useEffect, useRef, useState } from 'react';
import { useNymRerouteAt } from '../../../net/nym-held-sheet';

/** `rerouting`: nym dropped a route that did not answer and is trying another */
export type Watch = 'ok' | 'slow' | 'rerouting' | 'timeout';

export type WatchPhase = 'default' | 'catch-up' | 'proving' | 'broadcast';

/** what a watch says on a running build's note line */
export const watchNote = (w: Watch): 'leave' | 'slow' | 'rerouting' =>
  w === 'ok' || w === 'timeout' ? 'leave' : w;

/** quiet this long reads as slow; this long ends it */
export const LIMITS: Record<WatchPhase, { slowMs: number; hardMs: number }> = {
  default: { slowMs: 45_000, hardMs: 5 * 60_000 },
  // batches land every second or two; the replay at the end is one long step
  'catch-up': { slowMs: 90_000, hardMs: 10 * 60_000 },
  proving: { slowMs: 150_000, hardMs: 6 * 60_000 },
  // over nym a broadcast may try a few routes, then ask (nym-bridge NYM_BUDGET_MS + NYM_ANSWER_MS)
  broadcast: { slowMs: 45_000, hardMs: 4 * 60_000 },
};

export const isHeartbeat = (step: string) => step.startsWith('proving (halo2)');

export const phaseOf = (step: string | undefined): WatchPhase =>
  !step
    ? 'default'
    : step.startsWith('catch-up') || step.startsWith('witness corrupt')
      ? 'catch-up'
      : step.includes('broadcasting')
        ? 'broadcast'
        : /proving|PCZT \(halo2\)|building & proving|building, proving/.test(step)
          ? 'proving'
          : 'default';

/** `quietSince`: when the last real progress label arrived (or the build began) */
export const watchOf = (step: string | undefined, quietSince: number, now: number): Watch => {
  const { slowMs, hardMs } = LIMITS[phaseOf(step)];
  const quiet = now - quietSince;
  return quiet >= hardMs ? 'timeout' : quiet >= slowMs ? 'slow' : 'ok';
};

/**
 * Watch a running build. `steps` is the list of labels so far, `since` when
 * the build began; `active` false parks the clock (nothing to watch).
 */
export function useSendWatch(
  steps: readonly { step: string }[],
  since: number,
  active: boolean,
): Watch {
  const last = useRef<{ count: number; step?: string; at: number }>({ count: 0, at: since });
  const real = steps.filter(s => !isHeartbeat(s.step));
  if (real.length !== last.current.count || (real.length === 0 && last.current.at < since)) {
    last.current = {
      count: real.length,
      step: real.at(-1)?.step,
      at: real.length ? Date.now() : since,
    };
  }
  const rerouted = useNymRerouteAt() > since;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) {
      return;
    }
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [active]);
  const watch = active ? watchOf(last.current.step, last.current.at, now) : 'ok';
  return active && rerouted && watch !== 'timeout' ? 'rerouting' : watch;
}
