/** @vitest-environment node */

import { describe, expect, test } from 'vitest';
import { nextDelay, withPoll } from './poll';
import type {
  MempoolFetchContext,
  MempoolFetcher,
  MempoolSnapshot,
} from '../types';

const ctx = (signal: AbortSignal): MempoolFetchContext => ({ signal });

function once(snap: MempoolSnapshot): MempoolFetcher {
  return async function* () {
    yield snap;
  };
}

describe('withPoll', () => {
  test('yields each iteration of inner until aborted', async () => {
    let calls = 0;
    const inner: MempoolFetcher = async function* () {
      calls += 1;
      yield { entries: [], observedAtMs: calls };
    };
    const ctrl = new AbortController();
    const wrapped = withPoll({ intervalMs: 5, stepMs: 50 })(inner);

    const seen: number[] = [];
    const iter = wrapped('w', ctx(ctrl.signal));
    for await (const snap of iter) {
      seen.push(snap.observedAtMs);
      if (seen.length === 3) ctrl.abort();
    }

    expect(seen).toEqual([1, 2, 3]);
    expect(calls).toBe(3);
  });

  test('does not call inner once aborted before first call', async () => {
    let calls = 0;
    const inner: MempoolFetcher = async function* () {
      calls += 1;
      yield { entries: [], observedAtMs: Date.now() };
    };
    const ctrl = new AbortController();
    ctrl.abort();
    const wrapped = withPoll({ intervalMs: 5 })(inner);
    for await (const _ of wrapped('w', ctx(ctrl.signal))) { /* */ }
    expect(calls).toBe(0);
  });

  test('zero interval still polls (back-to-back)', async () => {
    let calls = 0;
    const inner: MempoolFetcher = async function* () {
      calls += 1;
      yield { entries: [], observedAtMs: calls };
    };
    const ctrl = new AbortController();
    const wrapped = withPoll({ intervalMs: 0 })(inner);
    let count = 0;
    for await (const _ of wrapped('w', ctx(ctrl.signal))) {
      count += 1;
      if (count >= 4) ctrl.abort();
    }
    expect(count).toBe(4);
  });

  test('passes walletId through unchanged', async () => {
    const seen: string[] = [];
    const inner: MempoolFetcher = async function* (wid) {
      seen.push(wid);
      yield { entries: [], observedAtMs: 0 };
    };
    const ctrl = new AbortController();
    const wrapped = withPoll({ intervalMs: 5 })(inner);
    const iter = wrapped('alice', ctx(ctrl.signal));
    let n = 0;
    for await (const _ of iter) { if (++n >= 2) ctrl.abort(); }
    expect(seen).toEqual(['alice', 'alice']);
  });

  describe('nextDelay (phase-align + jitter)', () => {
    test('phase-aligned: snaps to next 10s wall-clock slot', () => {
      // now = 12_345 → next 10s slot is 20_000 → delay = 7_655
      const d = nextDelay(10_000, 0, true, () => 0.5, 12_345);
      expect(d).toBe(7_655);
    });

    test('phase-aligned at exact slot boundary returns full interval', () => {
      // when now lands exactly on a slot, next slot is intervalMs away
      const d = nextDelay(10_000, 0, true, () => 0.5, 20_000);
      expect(d).toBe(10_000);
    });

    test('phase-disabled returns flat interval', () => {
      const d = nextDelay(10_000, 0, false, () => 0.5, 12_345);
      expect(d).toBe(10_000);
    });

    test('jitter is symmetric around base', () => {
      // rng=0 → jitter = -jitterMs (lower bound)
      // rng=1 → jitter = +jitterMs (upper bound)
      const low = nextDelay(10_000, 3_000, false, () => 0, 0);
      const high = nextDelay(10_000, 3_000, false, () => 1, 0);
      expect(low).toBe(7_000);
      expect(high).toBe(13_000);
    });

    test('jitter never produces negative delay', () => {
      // huge jitter relative to base: must clamp at 0
      const d = nextDelay(1_000, 5_000, false, () => 0, 0);
      expect(d).toBe(0);
    });

    test('phase-aligned + jitter: aligned base, jittered around it', () => {
      // now = 12_345, base = 7_655 (to slot 20_000), rng = 0.5 → jitter = 0
      const d = nextDelay(10_000, 1_000, true, () => 0.5, 12_345);
      expect(d).toBe(7_655);
    });
  });

  test('snapshot from inner reaches caller verbatim', async () => {
    const ctrl = new AbortController();
    const wrapped = withPoll({ intervalMs: 0 })(once({
      entries: [{ hash: new Uint8Array([1, 2, 3]), actions: [] }],
      observedAtMs: 42,
    }));
    let got: MempoolSnapshot | null = null;
    for await (const s of wrapped('w', ctx(ctrl.signal))) {
      got = s;
      ctrl.abort();
    }
    expect(got?.observedAtMs).toBe(42);
    expect(got?.entries[0]?.hash[0]).toBe(1);
  });
});
