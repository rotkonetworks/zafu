/**
 * State-transition tests for the IBC transfer tracker core.
 *
 * The core is deliberately free of chrome APIs and RPC clients, so these run
 * with an in-memory storage adapter, an injected clock, and a fake
 * destination-balance probe - no browser, no network.
 */

import { describe, it, expect } from 'vitest';
import {
  track,
  pollOnce,
  transition,
  isTerminalTransferStatus,
  type IbcTransfer,
  type TransferStorage,
  type TrackerDeps,
  type NewTransfer,
} from './ibc-transfer-tracker';

/** in-memory TransferStorage */
const memoryStorage = (): TransferStorage => {
  const map = new Map<string, IbcTransfer>();
  return {
    getAll: () => Promise.resolve(Object.fromEntries(map)),
    put: t => {
      map.set(t.id, t);
      return Promise.resolve();
    },
    remove: id => {
      map.delete(id);
      return Promise.resolve();
    },
  };
};

/** a clock the test advances by hand */
const clock = (start: number) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

/** a probe whose returned destination balance the test controls */
const fakeProbe = () => {
  let balance: bigint | undefined = 0n;
  const probe = () => Promise.resolve(balance);
  return { probe, set: (b: bigint | undefined) => (balance = b) };
};

const T0 = 1_000_000;
const TEN_MIN = 10 * 60 * 1000;

const newUnshield = (): NewTransfer => ({
  id: 'tx-abc',
  direction: 'unshield',
  amount: '5000000', // 5 USDC at 6 decimals
  denom: 'USDC',
  srcTxHash: 'tx-abc',
  expiresAt: T0 + TEN_MIN,
  destChainId: 'noble',
  destAddress: 'noble1burner',
  destDenom: 'uusdc',
});

describe('ibc-transfer-tracker: broadcast -> arrived', () => {
  it('captures baseline eagerly and flips to arrived when the destination balance rises by the amount', async () => {
    const storage = memoryStorage();
    const cl = clock(T0);
    const dest = fakeProbe();
    const deps: TrackerDeps = { storage, now: cl.now };

    // burner already holds 2 USDC before the transfer
    dest.set(2_000_000n);
    const recorded = await track(newUnshield(), dest.probe, deps);
    expect(recorded.status).toBe('broadcast');
    expect(recorded.baseline).toBe('2000000'); // eager baseline capture

    // relay still in flight - balance unchanged
    let r = await pollOnce(recorded.id, dest.probe, deps);
    expect(r?.status).toBe('broadcast');

    // funds land: baseline (2) + amount (5) = 7 USDC now present
    cl.advance(30_000);
    dest.set(7_000_000n);
    r = await pollOnce(recorded.id, dest.probe, deps);
    expect(r?.status).toBe('arrived');
    expect(r?.arrivedAt).toBe(T0 + 30_000);

    // terminal is sticky: a later poll never moves it back
    cl.advance(TEN_MIN * 2);
    dest.set(0n);
    r = await pollOnce(recorded.id, dest.probe, deps);
    expect(r?.status).toBe('arrived');
  });

  it('arrival wins over a same-tick expiry', () => {
    const t: IbcTransfer = {
      ...newUnshield(),
      status: 'broadcast',
      startedAt: T0,
      baseline: '0',
    };
    // now is past expiry AND balance has arrived -> arrived, not timeout
    const next = transition(t, 5_000_000n, t.expiresAt + 1);
    expect(next.status).toBe('arrived');
  });
});

describe('ibc-transfer-tracker: broadcast -> timeout', () => {
  it('flips to timeout when the IBC deadline passes without arrival', async () => {
    const storage = memoryStorage();
    const cl = clock(T0);
    const dest = fakeProbe();
    const deps: TrackerDeps = { storage, now: cl.now };

    dest.set(1_000_000n);
    const recorded = await track(newUnshield(), dest.probe, deps);
    expect(recorded.baseline).toBe('1000000');

    // a poll before the deadline stays pending
    cl.advance(TEN_MIN - 1000);
    let r = await pollOnce(recorded.id, dest.probe, deps);
    expect(r?.status).toBe('broadcast');

    // deadline passes, funds never arrived -> timeout
    cl.advance(2000);
    r = await pollOnce(recorded.id, dest.probe, deps);
    expect(r?.status).toBe('timeout');
    expect(isTerminalTransferStatus(r!.status)).toBe(true);
  });

  it('can time out even when the destination probe keeps failing (no baseline)', async () => {
    const storage = memoryStorage();
    const cl = clock(T0);
    const deps: TrackerDeps = { storage, now: cl.now };
    // probe always fails -> baseline never captured
    const failing = () => Promise.reject(new Error('rpc down'));

    const recorded = await track(newUnshield(), failing, deps);
    expect(recorded.baseline).toBeUndefined();

    cl.advance(TEN_MIN + 1);
    const r = await pollOnce(recorded.id, failing, deps);
    expect(r?.status).toBe('timeout');
  });

  it('recovers from timeout to arrived when a lagging destination finally confirms', async () => {
    const storage = memoryStorage();
    const cl = clock(T0);
    const dest = fakeProbe();
    const deps: TrackerDeps = { storage, now: cl.now };

    dest.set(0n);
    const recorded = await track(newUnshield(), dest.probe, deps);

    // deadline passes before the destination view catches up -> presumed timeout
    cl.advance(TEN_MIN + 1);
    let r = await pollOnce(recorded.id, dest.probe, deps);
    expect(r?.status).toBe('timeout');

    // the transfer actually landed; a later poll must recover it, not stay stuck
    cl.advance(60_000);
    dest.set(5_000_000n);
    r = await pollOnce(recorded.id, dest.probe, deps);
    expect(r?.status).toBe('arrived');
    expect(r?.arrivedAt).toBe(T0 + TEN_MIN + 1 + 60_000);

    // arrived is now truly terminal
    dest.set(0n);
    r = await pollOnce(recorded.id, dest.probe, deps);
    expect(r?.status).toBe('arrived');
  });
});
