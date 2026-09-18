import { describe, it, expect } from 'vitest';
import { generateMnemonic } from 'bip39';
import { deriveCosmosWallet, createSigningClient, deriveKeplrWireKey } from './signer';
import { deriveAllAddresses, convertAddress } from './client';

// FUND SAFETY: Injective (Ethermint, eth_secp256k1, coin type 60, keccak address)
// must NEVER be derived/signed on the shared coin-118 (m/44'/118', ripemd160)
// path - that yields a plausible-looking but WRONG, unspendable inj1 address.
const M = generateMnemonic();

describe('coin-118 guards refuse Ethermint chains', () => {
  it('deriveCosmosWallet refuses the inj prefix', async () => {
    await expect(deriveCosmosWallet(M, 0, 'inj')).rejects.toThrow(/Ethermint/);
  });

  it('createSigningClient refuses the injective chain', async () => {
    await expect(createSigningClient('injective', M)).rejects.toThrow(/Ethermint/);
  });

  it('deriveKeplrWireKey refuses the inj prefix', async () => {
    await expect(deriveKeplrWireKey(M, 'inj', 'test')).rejects.toThrow(/Ethermint/);
  });

  it('a normal coin-118 prefix still derives', async () => {
    const w = await deriveCosmosWallet(M, 0, 'osmo');
    expect(w.address.startsWith('osmo1')).toBe(true);
  });

  it('deriveAllAddresses excludes injective and convertAddress refuses it', async () => {
    const w = await deriveCosmosWallet(M, 0, 'osmo');
    const all = deriveAllAddresses(w.address);
    expect('injective' in all).toBe(false);
    expect('osmosis' in all).toBe(true);
    expect(() => convertAddress(w.address, 'injective')).toThrow(/Ethermint/);
  });
});
