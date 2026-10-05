import { describe, expect, it } from 'vitest';
import { chainIsMainnet, isWrongNetwork, walletIsMainnet } from './chain-network';

describe('chain network', () => {
  it('reads the names nodes answer', () => {
    expect(chainIsMainnet('main')).toBe(true);
    expect(chainIsMainnet(' Main ')).toBe(true);
    expect(chainIsMainnet('test')).toBe(false);
    expect(chainIsMainnet('regtest')).toBe(false);
    expect(chainIsMainnet('')).toBeUndefined();
    expect(chainIsMainnet('zcash-foo')).toBeUndefined();
  });

  it('refuses only a node that names the other network', () => {
    expect(isWrongNetwork('test', true)).toBe(true);
    expect(isWrongNetwork('main', false)).toBe(true);
    expect(isWrongNetwork('main', true)).toBe(false);
    expect(isWrongNetwork('test', false)).toBe(false);
    expect(isWrongNetwork('', true)).toBe(false);
  });

  it("a wallet's network follows its viewing key", () => {
    expect(walletIsMainnet(undefined)).toBe(true);
    expect(walletIsMainnet('uview1abc')).toBe(true);
    expect(walletIsMainnet('uviewtest1abc')).toBe(false);
  });
});
