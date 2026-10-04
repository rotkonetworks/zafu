import { describe, expect, it } from 'vitest';
import { zignerCodeChain } from './zigner-code';

describe('zignerCodeChain', () => {
  it('reads zcash codes', () => {
    expect(zignerCodeChain('ur:zcash-pczt/1-3/lpadaxcs')).toBe('zcash');
    expect(zignerCodeChain('UR:ZIGNER-MODULE/2-9/lpaoas')).toBe('zcash');
    expect(zignerCodeChain('530403ab')).toBe('zcash');
  });

  it('reads penumbra codes, including the bare signature reply', () => {
    expect(zignerCodeChain('ur:penumbra-accounts/oyaxhd')).toBe('penumbra');
    expect(zignerCodeChain('530310ff')).toBe('penumbra');
    expect(zignerCodeChain('ab'.repeat(66))).toBe('penumbra');
  });

  it('stays unsure about anything else', () => {
    expect(zignerCodeChain('https://zafu.pro')).toBeUndefined();
    expect(zignerCodeChain('P1/3/zcash-pczt/AAAA')).toBeUndefined();
    expect(zignerCodeChain('530103ff')).toBeUndefined();
    expect(zignerCodeChain('abcd')).toBeUndefined();
  });
});
