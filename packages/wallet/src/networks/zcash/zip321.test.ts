import { describe, expect, it } from 'vitest';
import { buildZip321, formatZecAmount, parseZecAmount, parseZip321 } from './zip321';

// examples from https://zips.z.cash/zip-0321
const SAPLING =
  'ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez';
const T = 'tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU';

describe('zip321 parse: spec examples', () => {
  it('single payment with amount, memo and message', () => {
    expect(
      parseZip321(
        `zcash:${SAPLING}?amount=1&memo=VGhpcyBpcyBhIHNpbXBsZSBtZW1vLg&message=Thank%20you%20for%20your%20purchase`,
      ),
    ).toEqual({
      ok: true,
      payments: [
        {
          address: SAPLING,
          amountZat: 100_000_000n,
          memo: 'This is a simple memo.',
          message: 'Thank you for your purchase',
        },
      ],
    });
  });

  it('two payments with a unicode memo', () => {
    const r = parseZip321(
      `zcash:?address=${T}&amount=123.456&address.1=${SAPLING}&amount.1=0.789&memo.1=VGhpcyBpcyBhIHVuaWNvZGUgbWVtbyDinKjwn6aE8J-PhvCfjok`,
    );
    expect(r).toEqual({
      ok: true,
      payments: [
        { address: T, amountZat: 12_345_600_000n },
        { address: SAPLING, amountZat: 78_900_000n, memo: 'This is a unicode memo ✨🦄🏆🎉' },
      ],
    });
  });

  it.each([
    [`zcash:?amount=3491405.05201255&address.1=${SAPLING}&amount.1=5740296.87793245`, 'no address'],
    [`zcash:?address=${T}&amount=1&amount.1=2&address.2=${SAPLING}`, 'no address'],
    [`zcash:?address.0=${SAPLING}&amount.0=2`, 'malformed parameter'],
    [`zcash:?amount=1.234&amount=2.345&address=${T}`, 'duplicate'],
    [`zcash:?amount.1=1.234&amount.1=2.345&address.1=${T}`, 'duplicate'],
    [`zcash:${T}?amount=1%30`, 'invalid amount'],
    [`zcash:${T}?%61mount=1`, 'malformed parameter'],
    [`zcash:%74mEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU?amount=1`, 'malformed address'],
    [`zcash://${T}?amount=1`, 'malformed address'],
    [`zcash:?address=${SAPLING}&amount=5&req-asset=not@valid!chars`, 'required parameter'],
  ])('rejects %s', (uri, why) => {
    const r = parseZip321(uri);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toContain(why);
  });
});

describe('zip321 parse: edge cases', () => {
  it('a memo to a transparent address is rejected, not dropped', () => {
    const r = parseZip321(`zcash:${T}?memo=aGk`);
    expect(r.ok ? '' : r.error).toMatch(/transparent/);
  });

  it('ignores unknown optional parameters and empty ones', () => {
    expect(parseZip321(`zcash:${T}?foo=bar&&amount=0.5&`)).toEqual({
      ok: true,
      payments: [{ address: T, amountZat: 50_000_000n }],
    });
  });

  it('rejects standard-base64 characters in a memo', () => {
    expect(parseZip321(`zcash:${SAPLING}?memo=ab+c`).ok).toBe(false);
  });

  it('amount: at most 8 decimals, max supply', () => {
    expect(parseZecAmount('0.00000001')).toBe(1n);
    expect(parseZecAmount('007')).toBe(700_000_000n);
    expect(parseZecAmount('1.123456789')).toBeUndefined();
    expect(parseZecAmount('21000000.00000001')).toBeUndefined();
    expect(parseZecAmount('1e3')).toBeUndefined();
    expect(formatZecAmount(12_345_600_000n)).toBe('123.456');
  });
});

describe('zip321 build', () => {
  it('round-trips a request with amount, memo, label and message', () => {
    const p = {
      address: SAPLING,
      amountZat: 12_345_000n,
      memo: 'order 42 ✨',
      label: 'coffee & cake',
      message: 'thanks!',
    };
    expect(parseZip321(buildZip321(p))).toEqual({ ok: true, payments: [p] });
  });

  it('refuses a memo to a transparent address', () => {
    expect(() => buildZip321({ address: T, memo: 'x' })).toThrow(/transparent/);
  });
});
