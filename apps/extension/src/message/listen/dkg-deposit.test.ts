import { describe, expect, it } from 'vitest';
import { parseDkgDeposit } from './dkg-deposit';

describe('parseDkgDeposit', () => {
  it('no deposit is a plain join', () => {
    expect(parseDkgDeposit(undefined)).toBeNull();
    expect(parseDkgDeposit(null)).toBeNull();
  });

  it('keeps a well-formed deposit as sent', () => {
    expect(
      parseDkgDeposit({ vaultIndex: 2, amountZat: 100_000, memo: 'zk.poker/v1/payout:u1x' }),
    ).toEqual({
      vaultIndex: 2,
      amountZat: 100_000,
      memo: 'zk.poker/v1/payout:u1x',
    });
    expect(parseDkgDeposit({ vaultIndex: 0, amountZat: 1 })).toEqual({
      vaultIndex: 0,
      amountZat: 1,
    });
  });

  it.each([
    ['a string', 'deposit'],
    ['a site-named address', { address: 'u1evil', amountZat: 1 }],
    ['a negative index', { vaultIndex: -1, amountZat: 1 }],
    ['a fractional index', { vaultIndex: 1.5, amountZat: 1 }],
    ['an index past u32', { vaultIndex: 2 ** 32, amountZat: 1 }],
    ['a zero amount', { vaultIndex: 1, amountZat: 0 }],
    ['a fractional amount', { vaultIndex: 1, amountZat: 0.5 }],
    ['more than all zec', { vaultIndex: 1, amountZat: 21_000_001 * 1e8 }],
    ['an amount as text', { vaultIndex: 1, amountZat: '100' }],
    ['a memo over 512 bytes', { vaultIndex: 1, amountZat: 1, memo: 'é'.repeat(257) }],
    ['a memo that is not text', { vaultIndex: 1, amountZat: 1, memo: 7 }],
  ])('refuses %s', (_, raw) => {
    expect(parseDkgDeposit(raw)).toBe('invalid');
  });
});
