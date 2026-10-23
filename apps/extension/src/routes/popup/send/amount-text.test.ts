import { describe, expect, it } from 'vitest';
import { shortAmount } from './amount-text';

describe('shortAmount', () => {
  it('leaves ordinary amounts alone', () => {
    expect(shortAmount('12.5')).toBe('12.5');
    expect(shortAmount('0.000001')).toBe('0.000001');
    expect(shortAmount('7')).toBe('7');
  });
  it('cuts long fractions to 6 decimals, never rounding up', () => {
    expect(shortAmount('1.23456789')).toBe('1.234567');
    expect(shortAmount('0.1234569')).toBe('0.123456');
  });
  it('keeps 4 significant digits of a tiny amount', () => {
    expect(shortAmount('0.0000040530940932089409324902309402')).toBe('0.000004053');
  });
  it('drops trailing zeros left by the cut', () => {
    expect(shortAmount('3.10000000001')).toBe('3.1');
    expect(shortAmount('3.00000000001')).toBe('3');
  });
});
