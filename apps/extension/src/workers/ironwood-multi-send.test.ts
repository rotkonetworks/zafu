import { describe, expect, test } from 'vitest';
import { memoToHex, multiSendRoute, planIronwoodMultiSend } from './ironwood-multi-send';

const isT = (a: string) => /^(t1|t3|tm|t2)/.test(a);
const UA = 'utest1shielded';
const TADDR = 'tmTransparent';

describe('multi-output send routing', () => {
  test('from NU6.3 on, several outputs take one ironwood transaction', () => {
    expect(multiSendRoute(4_134_000, 4_134_000)).toBe('ironwood-one-tx');
    expect(multiSendRoute(10_000_000, 4_134_000)).toBe('ironwood-one-tx');
  });

  test('before NU6.3 the orchard builder pays them one transaction each', () => {
    expect(multiSendRoute(4_133_999, 4_134_000)).toBe('orchard-per-output');
  });
});

describe('memoToHex', () => {
  test('text is its UTF-8 bytes, a zafu structured memo passes through, none is null', () => {
    expect(memoToHex('hi')).toBe('6869');
    expect(memoToHex('ä')).toBe('c3a4');
    expect(memoToHex('ff5a0102')).toBe('ff5a0102');
    expect(memoToHex('')).toBeNull();
    expect(memoToHex(undefined)).toBeNull();
  });
});

describe('planIronwoodMultiSend', () => {
  test('every output, in order, with its memo; counts and total for the fee', () => {
    const plan = planIronwoodMultiSend(
      [
        { address: ` ${UA} `, amount: '300000', memo: 'seat' },
        { address: TADDR, amount: '1000' },
        { address: UA, amount: '200000', memo: 'ff5a00' },
      ],
      isT,
    );
    expect(plan.outputs).toEqual([
      { address: UA, amount: 300_000, memo_hex: '73656174' },
      { address: TADDR, amount: 1_000 },
      { address: UA, amount: 200_000, memo_hex: 'ff5a00' },
    ]);
    expect(plan.total).toBe(501_000n);
    expect(plan.shielded).toBe(2);
    expect(plan.transparent).toBe(1);
  });

  test('a memo for a transparent output is refused by index, before any prove', () => {
    expect(() =>
      planIronwoodMultiSend(
        [
          { address: UA, amount: '1', memo: 'ok' },
          { address: TADDR, amount: '1', memo: 'lost' },
        ],
        isT,
      ),
    ).toThrow(/^output 1: a memo cannot be delivered to a transparent address/);
  });

  test('no outputs, a non-positive or unsafe amount are refused without the value', () => {
    expect(() => planIronwoodMultiSend([], isT)).toThrow(/outputs array required/);
    expect(() => planIronwoodMultiSend([{ address: UA, amount: '0' }], isT)).toThrow(
      'output 0: invalid amount',
    );
    expect(() =>
      planIronwoodMultiSend(
        [
          { address: UA, amount: '5' },
          { address: UA, amount: String(2n ** 53n) },
        ],
        isT,
      ),
    ).toThrow('output 1: invalid amount');
  });
});
