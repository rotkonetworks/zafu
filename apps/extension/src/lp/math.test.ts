import { describe, expect, it } from 'vitest';
import {
  ADD_MEMO,
  afterAdd,
  afterFee,
  costTone,
  fairAmount,
  impermanentLoss,
  memoFits,
  parseZec,
  poolUnitsFor,
  quoteAdd,
  swapOut,
  withdrawMemo,
  withdrawZec,
  zecMoveSinceAdd,
  zecText,
  type PoolDepth,
} from './math';

/**
 * A real single-sided add, read from THORNode (2026-10-05): 0.115 zec from
 * t1JVSs2…qutEK at height 28096435. The pool one block before, and the
 * units THORNode credited.
 */
const BEFORE: PoolDepth = { asset: 34_817_115n, rune: 60_640_491_791n, units: 60_001_901_519n };
const ADDED = 11_500_000n;
const CREDITED = 8_504_694_842n;
const POOL_AFTER_UNITS = 68_506_596_361n;

/** the same position against the pool of 2026-10-05, with THORNode's own redeem values */
const NOW: PoolDepth = { asset: 1_884_160_158n, rune: 3_199_743_901_909n, units: 3_168_071_014_120n };
const ASSET_REDEEM = 5_058_032n;
const RUNE_REDEEM = 8_589_720_791n;
const OUTBOUND_FEE = 44_929n;
const L1_MIN_SLIP = 10n;

describe('pool units on an add (calculatePoolUnits)', () => {
  it('credits exactly what THORNode credited for a live add', () => {
    expect(poolUnitsFor(BEFORE, ADDED)).toBe(CREDITED);
    expect(afterAdd(BEFORE, ADDED).pool.units).toBe(POOL_AFTER_UNITS);
  });

  it('values an asym add at half on each side, as THORNode deposit values say', () => {
    // asset_deposit_value of that position was 5,750,000: a / 2
    const { units, pool } = afterAdd(BEFORE, ADDED);
    expect((units * pool.asset) / pool.units).toBe(ADDED / 2n - 1n);
  });

  it('keeps a rune scale for the first add into an empty pool', () => {
    expect(poolUnitsFor({ asset: 0n, rune: 0n, units: 0n }, 5n, 7n)).toBe(7n);
    expect(poolUnitsFor({ asset: 10n, rune: 20n, units: 0n }, 5n)).toBe(10n);
  });
});

describe('withdraw of an asset-only position (calculateWithdraw)', () => {
  it('has the symmetric shares THORNode reports as redeem values', () => {
    expect((CREDITED * NOW.asset) / NOW.units).toBe(ASSET_REDEEM);
    expect((CREDITED * NOW.rune) / NOW.units).toBe(RUNE_REDEEM);
  });

  it('pays the asset share plus the rune share swapped into zec', () => {
    const zat = withdrawZec(NOW, CREDITED, 10_000, L1_MIN_SLIP);
    // the rune half (27 bps of what is left) swaps at x X Y / (x + X)^2, above the 10 bps floor
    const X = NOW.rune - RUNE_REDEEM;
    const Y = NOW.asset - ASSET_REDEEM;
    const d = RUNE_REDEEM + X;
    expect(zat).toBe(ASSET_REDEEM + (RUNE_REDEEM * X * Y) / (d * d));
    // about twice the asset share, less the swap's slip
    expect(Number(zat) / Number(2n * ASSET_REDEEM)).toBeCloseTo(0.9973, 3);
    expect(afterFee(zat, OUTBOUND_FEE)).toBe(zat - OUTBOUND_FEE);
  });

  it('takes a part by basis points', () => {
    const all = withdrawZec(NOW, CREDITED, 10_000, L1_MIN_SLIP);
    const half = withdrawZec(NOW, CREDITED, 5_000, L1_MIN_SLIP);
    // a smaller swap slips less: two halves pay a little more than all at once
    expect(half * 2n).toBeGreaterThan(all);
    expect(Number(half * 2n - all) / Number(all)).toBeLessThan(0.002);
  });

  it('pays less than half the pool for half the pool: slip above the floor', () => {
    const pool: PoolDepth = { asset: 1_000_000_000n, rune: 1_000_000_000n, units: 1_000n };
    // half the units: 500M of each; the rune half swaps against the 500M left
    expect(withdrawZec(pool, 500n, 10_000, L1_MIN_SLIP)).toBe(500_000_000n + 125_000_000n);
  });

  it('charges the minimum slip when the real slip is below it (GetSwapCalc)', () => {
    // x = 1, X = 1e6, Y = 1e6: slip rounds to 0 bps, so the 10 bps floor applies
    expect(swapOut(1_000_000n, 1_000n, 1_000_000n, 10n)).toBe(998n);
    expect(swapOut(1_000_000n, 1_000n, 1_000_000n, 0n)).toBe(998n);
    expect(swapOut(0n, 0n, 1n, 10n)).toBe(0n);
  });

  it('returns nothing from an empty pool or no units', () => {
    expect(withdrawZec({ asset: 0n, rune: 1n, units: 1n }, 1n, 10_000, 10n)).toBe(0n);
    expect(withdrawZec(NOW, 0n, 10_000, 10n)).toBe(0n);
    expect(afterFee(10n, 44_929n)).toBe(0n);
  });
});

describe('cost against the market', () => {
  // the boards' pool (2026-10-04): 0.3488 zec, 604.8 rune, 600.0 units
  const THIN: PoolDepth = { asset: 34_881_265n, rune: 60_484_697_408n, units: 60_001_901_519n };
  const px = { zec: 1298, rune: 1270.86 / (604.84697408 / 0.34881265) };

  it('grows with the size of the add and keeps the boards\' thresholds', () => {
    const small = quoteAdd(THIN, 1_000_000n, px)!;
    const big = quoteAdd(THIN, 10_000_000n, px)!;
    expect(big.costPct!).toBeGreaterThan(small.costPct!);
    expect(costTone(small.costPct)).toBe('calm');
    expect(costTone(5)).toBe('warn');
    expect(costTone(10)).toBe('strong');
    expect(costTone(undefined)).toBe('calm');
  });

  it('is small in a deep pool at a fair price', () => {
    const deep: PoolDepth = { asset: 1_884_160_158n, rune: 3_199_743_901_909n, units: 3_168_071_014_120n };
    const p = { zec: 1325, rune: 0.78017178 };
    expect(quoteAdd(deep, 1_000_000n, p)!.costPct!).toBeLessThan(1);
  });

  it('has no cost without a market price, only units and share', () => {
    const q = quoteAdd(THIN, 1_000_000n)!;
    expect(q.costPct).toBeUndefined();
    expect(q.sharePct).toBeGreaterThan(0);
    expect(quoteAdd(THIN, 0n)).toBeUndefined();
  });

  it('offers the largest 0.001 step at or under 3%', () => {
    const fair = fairAmount(THIN, px);
    expect(fair % 100_000n).toBe(0n);
    expect(quoteAdd(THIN, fair, px)!.costPct!).toBeLessThanOrEqual(3);
    expect(quoteAdd(THIN, fair + 100_000n, px)!.costPct!).toBeGreaterThan(3);
  });
});

describe('memos', () => {
  it('adds single-sided to ZEC.ZEC', () => {
    expect(ADD_MEMO).toBe('+:ZEC.ZEC');
  });

  it('withdraws by basis points, 1 to 10000', () => {
    expect(withdrawMemo(10_000)).toBe('-:ZEC.ZEC:10000');
    expect(withdrawMemo(2_500)).toBe('-:ZEC.ZEC:2500');
    expect(() => withdrawMemo(0)).toThrow();
    expect(() => withdrawMemo(10_001)).toThrow();
    expect(() => withdrawMemo(12.5)).toThrow();
  });

  it('fits the 80-byte OP_RETURN, and refuses one past it', () => {
    expect(memoFits(ADD_MEMO)).toBe(true);
    expect(memoFits(withdrawMemo(10_000))).toBe(true);
    expect(memoFits('x'.repeat(80))).toBe(true);
    expect(memoFits('x'.repeat(81))).toBe(false);
    // bytes, not characters
    expect(memoFits('é'.repeat(41))).toBe(false);
  });
});

describe('price moves and amounts', () => {
  it('reads the move of zec against rune from the deposit values', () => {
    // deposited at 1000 rune per zec; the pool now holds 1300 per zec
    const pool = { asset: 100n, rune: 130_000n, units: 1n };
    expect(zecMoveSinceAdd(pool, 10n, 10_000n)).toBeCloseTo(0.3);
    expect(zecMoveSinceAdd(pool, 0n, 10n)).toBeUndefined();
  });

  it('measures impermanent loss against holding both halves', () => {
    expect(impermanentLoss(0)).toBe(0);
    expect(impermanentLoss(0.3)).toBeCloseTo(-0.0085, 3);
    expect(impermanentLoss(-0.3)).toBeCloseTo(-0.0157, 3);
  });

  it('parses zec text into zat, refusing junk and more than 8 places', () => {
    expect(parseZec('0.01')).toBe(1_000_000n);
    expect(parseZec('.002')).toBe(200_000n);
    expect(parseZec('1')).toBe(100_000_000n);
    expect(parseZec('0')).toBeUndefined();
    expect(parseZec('abc')).toBeUndefined();
    expect(parseZec('0.000000001')).toBeUndefined();
    expect(zecText(1_000_000n)).toBe('0.0100');
    expect(zecText(964_000n)).toBe('0.00964');
  });
});
