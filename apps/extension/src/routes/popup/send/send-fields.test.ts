import { describe, expect, test } from 'vitest';
import { matchesSearch } from './send-fields';

describe('asset picker search', () => {
  test('"usdt" matches every registry-named USDT variant by symbol', () => {
    const variants = ['USDT.axl', 'nUSDT', 'USDT.eth.rt', 'USDC', 'OSMO'];
    expect(variants.filter(v => matchesSearch(v, 'usdt'))).toEqual([
      'USDT.axl',
      'nUSDT',
      'USDT.eth.rt',
    ]);
  });

  test('is case-insensitive and ignores surrounding whitespace', () => {
    expect(matchesSearch('USDT.axl', '  UsDt  ')).toBe(true);
  });

  test('an empty query matches everything', () => {
    expect(matchesSearch('UM', '')).toBe(true);
    expect(matchesSearch('UM', '   ')).toBe(true);
  });

  test('a query with no match matches nothing', () => {
    expect(matchesSearch('USDT.axl', 'zzz')).toBe(false);
  });
});
