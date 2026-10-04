import { useSyncExternalStore } from 'react';

/**
 * A note-tree catch-up running inside a zcash build, read off the worker's
 * send-progress labels (zcash-worker.ts `catchUp`): "catch-up: start" names
 * the reason and the real block range, "catch-up: blocks" reports each
 * fetched batch, and any other label means the build moved on.
 *
 * Everything shown from it is measured: blocks done of the true range, and an
 * estimate only once two batches have given a real rate.
 */

/** why the fast path was not available; only 'diverged' means something was wrong */
export type CatchUpReason = 'unsynced' | 'moved' | 'unwitnessed' | 'diverged';

export interface CatchUp {
  since: number;
  reason: CatchUpReason;
  from: number;
  to: number;
  /** blocks fetched of `total`, once the first batch is in */
  done?: number;
  total?: number;
  /** the first batch: where the measured rate starts */
  firstAt?: number;
  firstDone?: number;
  lastAt?: number;
  /** all blocks are in; the tree is being replayed */
  replaying?: boolean;
}

/** the reason in one plain phrase */
export const REASON_LINE: Record<CatchUpReason, string> = {
  unsynced: 'this wallet has not followed the note tree here yet',
  moved: 'the tree moved since it was last synced',
  unwitnessed: 'some notes arrived since the last sync',
  diverged: 'the network’s tree differs from ours, so it is read again',
};

const num = (detail: string | undefined, key: string): number | undefined => {
  const m = new RegExp(`${key}=(\\d+)`).exec(detail ?? '');
  return m ? Number(m[1]) : undefined;
};

const REASONS = new Set<string>(['unsynced', 'moved', 'unwitnessed', 'diverged']);

/** the catch-up after one more progress label */
export const catchUpStep = (
  prev: CatchUp | undefined,
  step: string,
  detail: string | undefined,
  now: number,
): CatchUp | undefined => {
  if (step === 'catch-up: start') {
    const reason = /reason=(\w+)/.exec(detail ?? '')?.[1] ?? '';
    return {
      // a second start inside one build (orchard: missing, then moved) keeps the clock
      since: prev?.since ?? now,
      reason: REASONS.has(reason) ? (reason as CatchUpReason) : 'moved',
      from: num(detail, 'from') ?? 0,
      to: num(detail, 'to') ?? 0,
    };
  }
  if (!prev) {
    return undefined;
  }
  if (step === 'catch-up: blocks') {
    const done = num(detail, 'done');
    const total = num(detail, 'total');
    if (done === undefined || total === undefined) {
      return prev;
    }
    return prev.firstAt === undefined
      ? { ...prev, done, total, firstAt: now, firstDone: done, lastAt: now }
      : { ...prev, done, total, lastAt: now };
  }
  if (step.startsWith('catch-up: replaying')) {
    return { ...prev, replaying: true };
  }
  return step.startsWith('catch-up:') ? prev : undefined;
};

/** blocks per ms from two real samples, or nothing */
const rate = (c: CatchUp): number | undefined =>
  c.firstAt !== undefined &&
  c.lastAt !== undefined &&
  c.done !== undefined &&
  c.firstDone !== undefined &&
  c.lastAt > c.firstAt &&
  c.done > c.firstDone
    ? (c.done - c.firstDone) / (c.lastAt - c.firstAt)
    : undefined;

/** "about 2 min left" from the measured rate; undefined until there is one */
export const catchUpLeft = (c: CatchUp | undefined): string | undefined => {
  if (!c || c.replaying || c.done === undefined || c.total === undefined) {
    return undefined;
  }
  const r = rate(c);
  if (!r) {
    return undefined;
  }
  const secs = Math.ceil((c.total - c.done) / r / 1000);
  return secs <= 50
    ? `about ${Math.max(5, Math.ceil(secs / 5) * 5)}s left`
    : `about ${Math.max(1, Math.round(secs / 60))} min left`;
};

/** 0..1 of the blocks fetched, or undefined before the first batch */
export const catchUpShare = (c: CatchUp | undefined): number | undefined =>
  c?.replaying ? 1 : c?.done !== undefined && c.total ? c.done / c.total : undefined;

let current: CatchUp | undefined;
const listeners = new Set<() => void>();

// one listener for the realm, so a catch-up begun on the send screen is still
// known after the person goes back home
if (typeof window !== 'undefined') {
  window.addEventListener('zcash-send-progress', e => {
    const d = (e as CustomEvent<{ step?: unknown; detail?: unknown }>).detail;
    if (typeof d?.step !== 'string') {
      return;
    }
    const next = catchUpStep(
      current,
      d.step,
      typeof d.detail === 'string' ? d.detail : undefined,
      Date.now(),
    );
    if (next !== current) {
      current = next;
      listeners.forEach(l => l());
    }
  });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** the note-tree catch-up in progress, or undefined */
export const useCatchUp = () => useSyncExternalStore(subscribe, () => current);
