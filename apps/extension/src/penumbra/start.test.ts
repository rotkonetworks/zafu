import { describe, expect, it } from 'vitest';
import {
  adoptLegacyStart,
  penumbraHeightAt,
  resolveStart,
  runPercent,
  sameTarget,
  settledTarget,
  startsOf,
  type PenumbraTarget,
} from './start';
import { createRebuildScheduler } from '../rebuild-scheduler';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 2);
const TIP = 12_998_125;

describe('penumbraHeightAt', () => {
  it('lands before the real height even when blocks ran fast or the chain halted', () => {
    // a day of real 4.5s blocks is 19,200; the estimate must go back further
    const h = penumbraHeightAt(NOW - DAY, TIP, NOW);
    expect(h).toBeLessThanOrEqual(TIP - Math.floor(DAY / 4_500));
    expect(h % 10_000).toBe(0);
  });

  it('goes further back the earlier the date', () => {
    const week = penumbraHeightAt(NOW - 7 * DAY, TIP, NOW);
    const month = penumbraHeightAt(NOW - 30 * DAY, TIP, NOW);
    expect(month).toBeLessThan(week);
    expect(week).toBeLessThan(TIP);
  });

  it('clamps to the start of the chain, and reads 0 (or nonsense) as the start', () => {
    expect(penumbraHeightAt(Date.UTC(2020, 0, 1), TIP, NOW)).toBe(0);
    expect(penumbraHeightAt(0, TIP, NOW)).toBe(0);
    expect(penumbraHeightAt(NaN, TIP, NOW)).toBe(0);
    expect(penumbraHeightAt(NOW - DAY, 0, NOW)).toBe(0);
  });
});

describe('resolveStart', () => {
  it('starts a fresh wallet at the tip, allowed to snapshot there', () => {
    expect(resolveStart('tip', TIP, NOW)).toEqual({ creation: TIP, frontier: TIP });
  });

  it('turns a date into a decrypt-from height, never a snapshot', () => {
    const r = resolveStart({ since: NOW - 30 * DAY }, TIP, NOW);
    expect(r).toEqual({ creation: penumbraHeightAt(NOW - 30 * DAY, TIP, NOW) });
    expect(resolveStart({ since: 0 }, TIP, NOW)).toEqual({ creation: 0 });
  });

  it('keeps a resolved start as it is', () => {
    expect(resolveStart({ creation: 5 }, TIP, NOW)).toEqual({ creation: 5 });
  });
});

describe('adoptLegacyStart', () => {
  const legacy = { creation: 4_200_000, frontier: 4_200_017 };

  it('gives the global birthday to the only wallet', () => {
    expect(adoptLegacyStart(['w1'], legacy, undefined)).toEqual({
      w1: { creation: 4_200_000, frontier: 4_200_017 },
    });
    expect(adoptLegacyStart(['w1'], { creation: 7 }, { w2: 'tip' })).toEqual({
      w1: { creation: 7 },
      w2: 'tip',
    });
  });

  it('gives it to no one when there is no telling which wallet it was for', () => {
    expect(adoptLegacyStart(['w1', 'w2'], legacy, undefined)).toBeUndefined();
    expect(adoptLegacyStart([], legacy, undefined)).toBeUndefined();
  });

  it('never overwrites a wallet that already has a start', () => {
    expect(adoptLegacyStart(['w1'], legacy, { w1: { since: 0 } })).toBeUndefined();
  });

  it('adopts nothing from a frontier without a birthday', () => {
    expect(adoptLegacyStart(['w1'], { frontier: 9 }, undefined)).toBeUndefined();
  });

  it('leaves a sealed or unknown-shaped map alone instead of coercing it', () => {
    const sealed = { encrypted: { nonce: 'bm9uY2U=', cipherText: 'c2VhbGVk' } };
    for (const raw of [[], 'x', 42, null]) {
      expect(startsOf(raw)).toBeUndefined();
      expect(adoptLegacyStart(['w1'], legacy, raw)).toBeUndefined();
    }
    // an object passes through with its own keys kept, whatever they hold
    expect(adoptLegacyStart(['w1'], legacy, sealed)).toEqual({
      ...sealed,
      w1: { creation: 4_200_000, frontier: 4_200_017 },
    });
  });
});

describe('runPercent', () => {
  it('counts from where this run started, not from genesis', () => {
    // the founder's case: a resume at 12,997,731 is not "99%" before a block is read
    expect(runPercent(12_997_731, 12_997_731, 12_998_125)).toBe(0);
    expect(runPercent(12_997_928, 12_997_731, 12_998_125)).toBeCloseTo(50, 0);
    expect(runPercent(415_000, 0, 13_000_000)).toBeCloseTo(3.19, 1);
  });

  it('stays within 0..100 and handles an empty run', () => {
    expect(runPercent(10, 10, 10)).toBe(100);
    expect(runPercent(20, 10, 15)).toBe(100);
    expect(runPercent(5, 10, 20)).toBe(0);
    expect(runPercent(0, 0, 0)).toBe(0);
  });
});

describe('penumbra rebuild targets', () => {
  const setup = (initial: PenumbraTarget) => {
    let desired = initial;
    const built: PenumbraTarget[] = [];
    const s = createRebuildScheduler<PenumbraTarget>({
      desired: () => Promise.resolve(desired),
      same: sameTarget,
      rebuild: target => {
        built.push(target);
        return Promise.resolve();
      },
    });
    return { s, built, want: (t: PenumbraTarget) => (desired = t) };
  };

  it('builds the real services once the start is chosen, after waiting for it', async () => {
    const t = { walletId: 'w1', run: true };
    const { s, built } = setup(t);
    // boot ran for w1 and came back waiting for a start
    s.setRunning(settledTarget(t, 'w1', true));
    await s.request('start chosen');
    expect(built).toEqual([t]);
  });

  it('a running wallet is not rebuilt for an unrelated change', async () => {
    const t = { walletId: 'w1', run: true };
    const { s, built } = setup(t);
    s.setRunning(settledTarget(t, 'w1', false));
    await s.request('wallets changed');
    await s.request('network switch');
    expect(built).toEqual([]);
  });

  it('switching wallets rebuilds, switching back rebuilds again, no more', async () => {
    const w1 = { walletId: 'w1', run: true };
    const w2 = { walletId: 'w2', run: true };
    const { s, built, want } = setup(w1);
    s.setRunning(w1);
    want(w2);
    await s.request('wallet switch');
    await s.request('wallet switch');
    want(w1);
    await s.request('wallet switch');
    expect(built).toEqual([w2, w1]);
  });

  it('a boot that waited for unlock runs whichever wallet unlocked', async () => {
    const { s, built } = setup({ walletId: 'w1', run: true });
    s.setRunning({ walletId: undefined, run: true });
    await s.request('wallets changed');
    expect(built).toEqual([]);
  });

  it('a chain id the node changed rebuilds; an unknown one does not', async () => {
    const t = { walletId: 'w1', run: true, chainId: 'penumbra-1' };
    const { s, built, want } = setup(t);
    s.setRunning(settledTarget(t, 'w1', false));
    want({ ...t, chainId: undefined });
    await s.request('params unknown');
    expect(built).toEqual([]);
    want({ ...t, chainId: 'penumbra-2' });
    await s.request('chain id changed');
    expect(built).toEqual([{ ...t, chainId: 'penumbra-2' }]);
  });
});
