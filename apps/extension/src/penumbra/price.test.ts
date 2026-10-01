import { describe, expect, it, vi } from 'vitest';
import {
  cached,
  combine,
  fixedBook,
  fixedPairs,
  isFresh,
  rateOf,
  type PriceEntry,
  type Simulate,
} from './price';

const USDC = { id: 'usdc', exponent: 6 };
const UM = { id: 'um', exponent: 6 };
const OSMO = { id: 'osmo', exponent: 6 };
const ETH = { id: 'eth', exponent: 18 };
const ROCK = { id: 'rock', exponent: 0 };
const QUOTES = { usd: { quote: USDC, hub: UM }, um: { quote: UM, hub: USDC } };

/** a DEX as a table of display-unit rates; a pair not in it does not route */
const dex = (rates: Record<string, number>) => {
  const calls: string[] = [];
  const simulate: Simulate = async (from, to, amount) => {
    calls.push(`${from.id}>${to.id}:${amount}`);
    const r = rates[`${from.id}>${to.id}`];
    if (r === undefined) {
      return { filled: 0n, out: 0n };
    }
    const out = (Number(amount) / 10 ** from.exponent) * r * 10 ** to.exponent;
    return { filled: amount, out: BigInt(Math.round(out)) };
  };
  return { simulate, calls };
};

describe('fixed pass', () => {
  it('trades every asset into both quotes but itself, sorted by id, one display unit each', async () => {
    const { simulate, calls } = dex({});
    await fixedBook(simulate, [ROCK, OSMO, ETH], QUOTES)();
    expect(calls).toEqual([
      `eth>usdc:${10n ** 18n}`,
      `eth>um:${10n ** 18n}`,
      'osmo>usdc:1000000',
      'osmo>um:1000000',
      'rock>usdc:1',
      'rock>um:1',
      'um>usdc:1000000',
      'usdc>um:1000000',
    ]);
    expect(fixedPairs([OSMO, ROCK], QUOTES)).toHaveLength(6);
  });

  it('prices direct, through the hub, or not at all', async () => {
    const { simulate } = dex({
      'osmo>usdc': 0.033,
      'osmo>um': 5,
      'rock>um': 2,
      'um>usdc': 0.0066,
      'usdc>um': 150,
    });
    const book = await fixedBook(simulate, [OSMO, ROCK, ETH], QUOTES)();
    expect(book.usd).toEqual({
      usdc: 1,
      um: 0.0066,
      osmo: 0.033,
      rock: 2 * 0.0066,
      eth: null,
    });
    expect(book.um).toMatchObject({ um: 1, usdc: 150, osmo: 5, rock: 2, eth: null });
  });

  it('reads a failed trade as no route', async () => {
    const simulate: Simulate = async from => {
      if (from.id === 'osmo') {
        throw new Error('node down');
      }
      return { filled: 1_000_000n, out: 6_612n };
    };
    const book = await fixedBook(simulate, [OSMO], QUOTES)();
    expect(book.usd['osmo']).toBeNull();
    expect(book.usd['um']).toBeCloseTo(0.006612, 9);
  });
});

describe('combine', () => {
  const fixed = {
    usd: { usdc: 1, um: 0.0066, osmo: 0.033, rock: null },
    um: { um: 1, usdc: 150, osmo: 5, rock: null },
  };

  it('prefers the local price, then the fixed pass', () => {
    const book = combine(QUOTES, { osmo: { usd: 0.034 }, um: {} }, fixed);
    expect(book.usd).toEqual({ osmo: 0.034, um: 0.0066 });
    expect(book.um).toEqual({ osmo: 5, um: 1 });
  });

  it('crosses a local price through the hub when nothing else has it', () => {
    const book = combine(QUOTES, { rock: { um: 2 } }, fixed);
    expect(book.usd['rock']).toBeCloseTo(0.0132, 9);
    expect(book.um['rock']).toBe(2);
  });

  it('is no price with nothing local and no fixed pass', () => {
    expect(combine(QUOTES, { osmo: {}, usdc: {} }, undefined)).toEqual({
      usd: { osmo: null, usdc: 1 },
      um: { osmo: null, usdc: null },
    });
  });
});

describe('notional and precision', () => {
  it('rates a partial fill against the filled input only', () => {
    expect(rateOf(OSMO, USDC, { filled: 400_000n, out: 13_000n })).toBeCloseTo(0.0325, 9);
  });

  it('keeps sub-cent prices: 1 um is 6612 base units of usdc', () => {
    expect(rateOf(UM, USDC, { filled: 1_000_000n, out: 6_612n })).toBeCloseTo(0.006612, 9);
  });

  it('crosses exponents both ways', () => {
    expect(rateOf(ETH, USDC, { filled: 10n ** 18n, out: 2_500_000_000n })).toBe(2500);
    expect(rateOf(ROCK, ETH, { filled: 1n, out: 5n * 10n ** 17n })).toBe(0.5);
  });

  it('is no price when nothing filled', () => {
    expect(rateOf(OSMO, USDC, { filled: 0n, out: 0n })).toBeNull();
    expect(rateOf(OSMO, USDC, undefined)).toBeNull();
  });
});

describe('cache', () => {
  const entry: PriceEntry = { at: 1_000, book: { usd: { osmo: 0.03 }, um: { osmo: 5 } } };

  it('is fresh while younger than the ttl', () => {
    expect(isFresh(entry, 1_500, 1_000)).toBe(true);
    expect(isFresh(entry, 2_000, 1_000)).toBe(false);
    expect(isFresh(undefined, 0, 1_000)).toBe(false);
  });

  it('answers from a fresh pass and stores a new one when stale', async () => {
    let saved: PriceEntry | undefined = entry;
    const store = { get: async () => saved, set: async (e: PriceEntry) => void (saved = e) };
    const service = vi.fn(async () => ({ usd: { osmo: 0.04 }, um: { osmo: 6 } }));
    let now = 1_500;
    const priced = cached(store, 1_000, () => now)(service);

    expect((await priced()).book['usd']?.['osmo']).toBe(0.03);
    expect(service).not.toHaveBeenCalled();

    now = 2_500;
    expect(await priced()).toEqual({ at: 2_500, book: { usd: { osmo: 0.04 }, um: { osmo: 6 } } });
    expect(service).toHaveBeenCalledTimes(1);
    expect(saved?.at).toBe(2_500);
  });
});
