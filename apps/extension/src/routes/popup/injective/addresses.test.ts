import { describe, expect, it } from 'vitest';
import {
  MAX_INJECTIVE_SCAN,
  fundedBurners,
  injectiveScanIndices,
  mergeFundedIndices,
  pickDefaultInjectiveIndex,
  resolveSelectedInjectiveIndex,
  shortInjAddress,
  type InjectiveIndexBalance,
} from './addresses';

const row = (index: number, usdc: bigint, inj = 0n): InjectiveIndexBalance => ({
  index,
  address: `inj1addr${index}`,
  usdc,
  inj,
});

describe('injectiveScanIndices', () => {
  it('is just account 0 when no burner was handed out', () => {
    expect(injectiveScanIndices(0)).toEqual([0]);
  });

  it('covers 0..highest inclusive below the cap', () => {
    expect(injectiveScanIndices(3)).toEqual([0, 1, 2, 3]);
    expect(injectiveScanIndices(MAX_INJECTIVE_SCAN - 1)).toHaveLength(MAX_INJECTIVE_SCAN);
  });

  it('keeps 0 plus the most recent burners above the cap', () => {
    const idx = injectiveScanIndices(50);
    expect(idx).toHaveLength(MAX_INJECTIVE_SCAN);
    expect(idx[0]).toBe(0);
    expect(idx).toContain(50);
    expect(idx).toContain(32);
    expect(idx).not.toContain(31);
    expect(idx).not.toContain(1);
  });

  it('treats garbage counters as 0', () => {
    expect(injectiveScanIndices(-4)).toEqual([0]);
    expect(injectiveScanIndices(Number.NaN)).toEqual([0]);
    expect(injectiveScanIndices(1.5)).toEqual([0]);
  });
});

describe('pickDefaultInjectiveIndex', () => {
  it('defaults to 0 when nothing holds USDC', () => {
    expect(pickDefaultInjectiveIndex([])).toBe(0);
    expect(pickDefaultInjectiveIndex([row(0, 0n, 5n), row(2, 0n, 9n)])).toBe(0);
  });

  it('picks the largest USDC balance', () => {
    expect(pickDefaultInjectiveIndex([row(0, 10n), row(1, 5n), row(4, 30n)])).toBe(4);
  });

  it('breaks ties toward the lowest index', () => {
    expect(pickDefaultInjectiveIndex([row(3, 7n), row(0, 7n), row(1, 7n)])).toBe(0);
    expect(pickDefaultInjectiveIndex([row(0, 0n), row(5, 7n), row(2, 7n)])).toBe(2);
  });
});

describe('fundedBurners', () => {
  it('lists only index > 0 rows holding USDC or INJ', () => {
    const rows = [row(0, 100n), row(1, 0n), row(2, 0n, 1n), row(3, 4n)];
    expect(fundedBurners(rows).map(r => r.index)).toEqual([2, 3]);
  });
});

describe('resolveSelectedInjectiveIndex', () => {
  const rows = [row(0, 1n), row(1, 0n), row(2, 50n), row(3, 0n, 1n)];

  it('uses the default when the user has not picked', () => {
    expect(resolveSelectedInjectiveIndex(rows, undefined)).toBe(2);
  });

  it('honours a pick of an offered index', () => {
    expect(resolveSelectedInjectiveIndex(rows, 0)).toBe(0);
    expect(resolveSelectedInjectiveIndex(rows, 3)).toBe(3);
  });

  it('falls back to the default when the pick is no longer offered', () => {
    // index 1 is empty (e.g. just fully shielded), 9 was never scanned
    expect(resolveSelectedInjectiveIndex(rows, 1)).toBe(2);
    expect(resolveSelectedInjectiveIndex(rows, 9)).toBe(2);
  });

  it('is 0 before balances load', () => {
    expect(resolveSelectedInjectiveIndex([], 4)).toBe(0);
  });
});

describe('shortInjAddress', () => {
  it('shortens long addresses and leaves short ones', () => {
    expect(shortInjAddress('inj1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqwxyz')).toBe('inj1qqqq...wxyz');
    expect(shortInjAddress('inj1abc')).toBe('inj1abc');
  });
});

describe('injectiveScanIndices alwaysScan', () => {
  it('keeps an old funded index that fell out of the recent window', () => {
    const idx = injectiveScanIndices(50, MAX_INJECTIVE_SCAN, [3]);
    expect(idx).toContain(3);
    expect(idx).toContain(50);
    expect(idx[0]).toBe(0);
  });
  it('ignores remembered indices above the counter or invalid', () => {
    expect(injectiveScanIndices(2, MAX_INJECTIVE_SCAN, [7, -1, 1.5])).toEqual([0, 1, 2]);
  });
});

describe('mergeFundedIndices', () => {
  it('adds indices that hold anything, keeps remembered ones', () => {
    const rows = [
      { index: 0, address: 'a', usdc: 0n, inj: 0n },
      { index: 4, address: 'b', usdc: 1n, inj: 0n },
      { index: 9, address: 'c', usdc: 0n, inj: 5n },
    ];
    expect(mergeFundedIndices([2], rows)).toEqual([2, 4, 9]);
  });
});
