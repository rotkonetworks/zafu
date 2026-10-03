import { describe, expect, it } from 'vitest';
import { toHex } from 'viem';
import { deriveInjectiveWallet } from '@repo/wallet/networks/injective/derive';
import { baseAddressOf, withBaseAccount } from './base-key';

// the BIP-39 test mnemonic; m/44'/60'/0'/0/0 is the well-known MetaMask vector
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('base key', () => {
  it('is the standard coin-60 account 0 address', async () => {
    expect(await baseAddressOf(MNEMONIC)).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
  });

  it('is the same account Injective derives (one key, one 0x address)', async () => {
    const inj = await deriveInjectiveWallet(MNEMONIC, 0);
    expect(toHex(inj.addressBytes).toLowerCase()).toBe(
      (await baseAddressOf(MNEMONIC)).toLowerCase(),
    );
    inj.privateKey.fill(0);
  });

  it("signs as that address with viem's account", async () => {
    const addr = await withBaseAccount(MNEMONIC, async a => a.address);
    expect(addr).toBe(await baseAddressOf(MNEMONIC));
  });
});
