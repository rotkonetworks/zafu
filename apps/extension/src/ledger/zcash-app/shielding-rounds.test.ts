import { describe, expect, it, vi } from 'vitest';
import { CTX, fakePczt, harness } from './fakes.test-util';
import { LedgerShieldingSession, roundsFor, type ShieldingProgress } from './shielding-rounds';

/** A transparent pool that drains by the inputs each broadcast round spent. */
const pool = (inputs: number, opts: { stuck?: boolean } = {}) => {
  let remaining = inputs;
  let lastBuilt = 0;
  return {
    readEligible: vi.fn(async () => ({ inputCount: remaining, belowThreshold: false })),
    buildShieldPczt: vi.fn(async (maxInputs: number) => {
      lastBuilt = Math.min(remaining, maxInputs);
      return {
        pcztHex: fakePczt(lastBuilt),
        coldSendId: `shield-${remaining}`,
        transparentPaths: Array.from({ length: lastBuilt }, (_, inputIndex) => ({
          inputIndex,
          scope: 0 as const,
          addressIndex: 0,
          pubkey: new Uint8Array(33).fill(2),
        })),
      };
    }),
    onBroadcast: () => {
      if (!opts.stuck) {
        remaining -= lastBuilt;
      }
    },
  };
};

const session = (inputs: number, opts: { stuck?: boolean } = {}) => {
  const h = harness();
  const p = pool(inputs, opts);
  const base = h.broadcast.getMockImplementation()!;
  h.broadcast.mockImplementation(async (...args: [string, string, string?]) => {
    const r = await base(...args);
    p.onBroadcast();
    return r;
  });
  const s = new LedgerShieldingSession(
    { ...h.deps, readEligible: p.readEligible, buildShieldPczt: p.buildShieldPczt },
    CTX,
  );
  return { h, p, s };
};

describe('LedgerShieldingSession', () => {
  it('70 inputs -> 3 rounds, one approval each, in one device session', async () => {
    const { h, p, s } = session(70);
    const progress: ShieldingProgress[] = [];
    const out = await s.run({ onProgress: e => progress.push(e) });

    expect(out.status).toBe('complete');
    expect(out.txids).toHaveLength(3);
    expect(h.device.exchanges).toBe(3);
    expect(p.buildShieldPczt.mock.calls.map(c => c[0])).toEqual([32, 32, 32]);
    // every round was within the device limit
    expect(h.protocol.validatePczt).toHaveBeenCalledTimes(3);
    // round count is recomputed each round and stays honest: 3 throughout
    const totals = new Set(progress.filter(e => e.totalRounds > 0).map(e => e.totalRounds));
    expect([...totals]).toEqual([3]);
    expect(Math.max(...progress.filter(e => e.step !== 'checking').map(e => e.round))).toBe(3);
    expect(h.device.closed).toBe(false);
    expect(await h.store.list()).toEqual([]);
    // every round's inputs were stamped with their derivation paths
    expect(h.stampDerivations.mock.calls.map(c => c[1].transparentPaths.length)).toEqual([
      32, 32, 6,
    ]);
  });

  it('pauses when eligible inputs do not decrease after a broadcast', async () => {
    const { h, s } = session(40, { stuck: true });
    const out = await s.run();
    expect(out).toMatchObject({ status: 'paused', reason: 'no_decrease' });
    expect(out.txids).toHaveLength(1);
    expect(h.device.exchanges).toBe(1);
  });

  it('never treats a failed read as zero funds', async () => {
    const { h, p, s } = session(10);
    p.readEligible.mockRejectedValueOnce(new Error('zidecar unreachable'));
    await expect(s.run()).rejects.toMatchObject({ code: 'funds_unreadable' });
    expect(h.device.exchanges).toBe(0);
  });

  it('a failed read after a sent round pauses instead of completing', async () => {
    const { p, s } = session(40);
    p.readEligible
      .mockResolvedValueOnce({ inputCount: 40, belowThreshold: false })
      .mockRejectedValueOnce(new Error('timeout'));
    const out = await s.run();
    expect(out).toMatchObject({ status: 'paused', reason: 'unreadable' });
    expect(out.txids).toHaveLength(1);
  });

  it('pauses below the fee threshold', async () => {
    const { h, p, s } = session(3);
    p.readEligible.mockResolvedValue({ inputCount: 3, belowThreshold: true });
    expect(await s.run()).toMatchObject({ status: 'paused', reason: 'below_threshold' });
    expect(h.device.exchanges).toBe(0);
  });

  it('nothing eligible completes immediately', async () => {
    const { h, s } = session(0);
    expect(await s.run()).toEqual({ status: 'complete', txids: [] });
    expect(h.device.exchanges).toBe(0);
  });

  it('uncertain broadcast pauses the session and starts no further round', async () => {
    const { h, s } = session(70);
    h.broadcast.mockRejectedValueOnce(new Error('network error'));
    const out = await s.run();
    expect(out).toMatchObject({ status: 'paused', reason: 'uncertain' });
    expect(h.device.exchanges).toBe(1);
    expect((await h.store.list())[0]?.state).toBe('broadcast_uncertain');
  });

  it('a rejected round is retried in place; later rounds still get their own approval', async () => {
    const { h, p, s } = session(40);
    h.device.behaviour = 'reject';
    await expect(s.run()).rejects.toMatchObject({ failure: 'rejected' });
    h.device.behaviour = 'approve';
    const out = await s.run();
    expect(out.status).toBe('complete');
    expect(out.txids).toHaveLength(2);
    // round 1 was built once and re-approved; round 2 built fresh
    expect(p.buildShieldPczt).toHaveBeenCalledTimes(2);
    expect(h.device.exchanges).toBe(3);
  });

  it('checkpoint failure mid-session retries without re-signing', async () => {
    const { h, s } = session(20);
    h.area.failNextSets = 1;
    await expect(s.run()).rejects.toMatchObject({ code: 'checkpoint_failed' });
    expect((await s.run()).status).toBe('complete');
    expect(h.device.exchanges).toBe(1);
  });

  it('stops when the account changes between rounds', async () => {
    const { h, s } = session(70);
    const base = h.broadcast.getMockImplementation()!;
    h.broadcast.mockImplementationOnce(async (...args: [string, string, string?]) => {
      const r = await base(...args);
      h.current.ok = false;
      return r;
    });
    await expect(s.run()).rejects.toMatchObject({ code: 'context_changed' });
    expect(h.device.exchanges).toBe(1);
  });

  it('roundsFor', () => {
    expect(roundsFor(70, 32)).toBe(3);
    expect(roundsFor(32, 32)).toBe(1);
    expect(roundsFor(33, 32)).toBe(2);
  });
});
