import { describe, expect, it } from 'vitest';
import { chainByChainId } from './chains';
import { deriveChainAddress, deriveCosmosWallet } from './signer';

// a public test seed; it never holds funds. Addresses from @keplr-wallet/crypto
// on m/44'/118'/0'/0/0, the path chain-registry gives both chains (slip44 118)
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('terp network and juno', () => {
  it.each([
    ['morocco-1', 'terp', 'terp19rl4cm2hmr8afy4kldpxz3fka4jguq0am2y34x'],
    ['juno-1', 'juno', 'juno19rl4cm2hmr8afy4kldpxz3fka4jguq0a2jwxcf'],
  ])('%s derives on coin type 118', async (chainId, prefix, address) => {
    const chain = chainByChainId(chainId)!;
    expect(chain.bech32Prefix).toBe(prefix);
    expect((await deriveCosmosWallet(MNEMONIC, 0, prefix)).address).toBe(address);
    expect(deriveChainAddress('cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4', chain.id)).toBe(
      address,
    );
  });

  it('terp stakes terp and pays fees in thiol', () => {
    const terp = chainByChainId('morocco-1')!;
    expect([terp.symbol, terp.denom, terp.decimals]).toEqual(['TERP', 'uterp', 6]);
    expect(terp.gasAsset).toEqual({ symbol: 'THIOL', denom: 'uthiol', decimals: 6 });
    expect(terp.gasPrice).toBe('0.05uthiol');
  });
});
