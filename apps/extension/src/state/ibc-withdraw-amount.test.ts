import { describe, expect, it } from 'vitest';
import { isValidWithdrawAmount, toBaseUnits } from './ibc-withdraw-amount';
import { timeoutBlocksForChain } from './ibc-withdraw-timeout';

describe('toBaseUnits', () => {
  describe('6 decimals (UM, USDC, stablecoins)', () => {
    it('scales whole numbers', () => {
      expect(toBaseUnits('1', 6)).toBe(1_000_000n);
      expect(toBaseUnits('100', 6)).toBe(100_000_000n);
    });

    it('scales fractional amounts exactly', () => {
      expect(toBaseUnits('1.5', 6)).toBe(1_500_000n);
      expect(toBaseUnits('0.000001', 6)).toBe(1n);
      expect(toBaseUnits('12.345678', 6)).toBe(12_345_678n);
    });

    it('does not lose a base unit to binary floating point', () => {
      // the regression this module exists for: parseFloat('2.01') * 1e6 is
      // 2009999.9999999998, and Math.floor took it to 2009999 - a base unit
      // short of what the user typed.
      expect(Math.floor(parseFloat('2.01') * 1_000_000)).toBe(2_009_999);
      expect(toBaseUnits('2.01', 6)).toBe(2_010_000n);

      expect(Math.floor(parseFloat('4.10') * 1_000_000)).toBe(4_099_999);
      expect(toBaseUnits('4.10', 6)).toBe(4_100_000n);

      expect(toBaseUnits('2.09', 6)).toBe(2_090_000n);
      expect(toBaseUnits('8.87', 6)).toBe(8_870_000n);
    });

    it('accepts a leading decimal point and trailing zeros', () => {
      expect(toBaseUnits('.25', 6)).toBe(250_000n);
      expect(toBaseUnits('1.000000', 6)).toBe(1_000_000n);
      expect(toBaseUnits('7.', 6)).toBe(7_000_000n);
    });

    it('trims surrounding whitespace', () => {
      expect(toBaseUnits('  2.5  ', 6)).toBe(2_500_000n);
    });
  });

  describe('18 decimals (INJ)', () => {
    it('scales by 1e18, not 1e6', () => {
      expect(toBaseUnits('1', 18)).toBe(1_000_000_000_000_000_000n);
      // what the old hardcoded path produced for "1 INJ"
      expect(toBaseUnits('1', 18)).not.toBe(1_000_000n);
    });

    it('keeps precision beyond what a double can represent', () => {
      expect(toBaseUnits('1.000000000000000001', 18)).toBe(1_000_000_000_000_000_001n);
      expect(toBaseUnits('0.000000000000000001', 18)).toBe(1n);
      expect(toBaseUnits('123456.789012345678901234', 18)).toBe(123_456_789_012_345_678_901_234n);
    });

    it('produces values that exceed a u64 (so lo/hi splitting is required)', () => {
      const U64_MAX = 2n ** 64n - 1n;
      // ~18.45 INJ is already past u64
      expect(toBaseUnits('100', 18)).toBeGreaterThan(U64_MAX);
    });
  });

  describe('0 decimals', () => {
    it('passes integers through', () => {
      expect(toBaseUnits('42', 0)).toBe(42n);
    });

    it('rejects any fractional part', () => {
      expect(() => toBaseUnits('1.5', 0)).toThrow(/decimal places/);
    });
  });

  describe('rounding / validation of too many fractional digits', () => {
    it('throws rather than truncating', () => {
      expect(() => toBaseUnits('1.1234567', 6)).toThrow(
        'amount has 7 decimal places but this asset supports at most 6',
      );
      expect(() => toBaseUnits('0.0000001', 6)).toThrow(/decimal places/);
      expect(() => toBaseUnits('1.0000000000000000001', 18)).toThrow(/decimal places/);
    });
  });

  describe('malformed input', () => {
    it.each([
      ['', 'amount is empty'],
      ['   ', 'amount is empty'],
      ['abc', /invalid amount/],
      ['-1', /invalid amount/],
      ['1e6', /invalid amount/],
      ['1,000', /invalid amount/],
      ['1.2.3', /invalid amount/],
      ['.', /invalid amount/],
      ['Infinity', /invalid amount/],
      ['NaN', /invalid amount/],
    ])('rejects %j', (input, matcher) => {
      expect(() => toBaseUnits(input, 6)).toThrow(matcher as string | RegExp);
    });

    it('rejects a nonsense exponent', () => {
      expect(() => toBaseUnits('1', -1)).toThrow(/invalid decimal exponent/);
      expect(() => toBaseUnits('1', 1.5)).toThrow(/invalid decimal exponent/);
    });
  });

  describe('zero', () => {
    it('parses to 0n rather than throwing', () => {
      expect(toBaseUnits('0', 6)).toBe(0n);
      expect(toBaseUnits('0.000000', 6)).toBe(0n);
    });
  });
});

describe('isValidWithdrawAmount', () => {
  it('accepts representable, positive amounts', () => {
    expect(isValidWithdrawAmount('1.5', 6)).toBe(true);
    expect(isValidWithdrawAmount('0.000000000000000001', 18)).toBe(true);
  });

  it('rejects zero, unrepresentable precision and garbage', () => {
    expect(isValidWithdrawAmount('0', 6)).toBe(false);
    expect(isValidWithdrawAmount('1.1234567', 6)).toBe(false);
    expect(isValidWithdrawAmount('', 6)).toBe(false);
    expect(isValidWithdrawAmount('-1', 6)).toBe(false);
  });
});

describe('timeoutBlocksForChain', () => {
  it('gives injective a window measured in hours, not minutes', () => {
    const blocks = timeoutBlocksForChain('injective-1');
    // 2h at ~0.7s blocks
    expect(blocks).toBe(10_286n);
    expect(blocks).toBeGreaterThan(5_000n);
    // the old flat constant was ~12 minutes of injective blocks
    expect(blocks).toBeGreaterThan(1_000n);
  });

  it('scales with noble’s slower blocks', () => {
    expect(timeoutBlocksForChain('noble-1')).toBe(1_310n);
  });

  it('falls back to a cosmos-default rate for unknown chains, never below the floor', () => {
    expect(timeoutBlocksForChain('some-unknown-1')).toBe(1_200n);
    expect(timeoutBlocksForChain('some-unknown-1')).toBeGreaterThanOrEqual(1_000n);
  });
});
