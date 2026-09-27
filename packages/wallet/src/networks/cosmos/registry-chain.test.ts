import { describe, expect, it } from 'vitest';
import { COSMOS_CHAINS } from './chains';

describe('chains from the cosmos chain registry', () => {
  it('builds celestia as a plain coin-118 chain', () => {
    const c = COSMOS_CHAINS.celestia;
    expect(c.chainId).toBe('celestia');
    expect(c.bech32Prefix).toBe('celestia');
    expect(c.coinType).toBe(118);
    expect(c.keyAlgo).toBeUndefined();
    expect(c.denom).toBe('utia');
    expect(c.decimals).toBe(6);
    expect(c.penumbraSourceChannel).toBe('channel-23');
  });

  it('builds kava on coin type 459', () => {
    const c = COSMOS_CHAINS.kava;
    expect(c.chainId).toBe('kava_2222-10');
    expect(c.bech32Prefix).toBe('kava');
    expect(c.coinType).toBe(459);
    expect(c.keyAlgo).toBeUndefined();
    expect(c.gasPrice).toMatch(/ukava$/);
    expect(c.penumbraSourceChannel).toBe('channel-21');
  });

  it('draws endpoints only from the trusted operators, over https', () => {
    for (const c of [COSMOS_CHAINS.celestia, COSMOS_CHAINS.kava]) {
      expect(c.rpcEndpoints?.length).toBeGreaterThan(0);
      for (const u of [...(c.rpcEndpoints ?? []), c.restEndpoint]) {
        expect(u).toMatch(
          /^https:\/\/[^/]*(polkachu\.com|publicnode\.com|cosmos\.directory|keplr\.app)/,
        );
      }
    }
  });
});
