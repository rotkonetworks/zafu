import { describe, expect, it } from 'vitest';
import { deriveEthAddress } from '../ethereum/derive';
import {
  HYPERLIQUID_DEFAULT_PATH,
  deriveHyperliquidAddress,
  deriveHyperliquidWallet,
  hyperliquidPath,
  isBip32Path,
} from './derive';

// the bip39 test phrase; its m/44'/60'/0'/0/0 address is widely published
const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('hyperliquid derivation', () => {
  it('is the one evm address by default, lowercased', async () => {
    const address = deriveHyperliquidAddress(PHRASE);
    expect(address).toBe('0x9858effd232b4033e47d90003d41ec34ecaeda94');
    expect(address).toBe((await deriveEthAddress(PHRASE)).toLowerCase());
  });

  it('follows a custom path to another key', () => {
    const custom = deriveHyperliquidAddress(PHRASE, "m/44'/60'/2000'/1/0");
    expect(custom).toMatch(/^0x[0-9a-f]{40}$/);
    expect(custom).not.toBe(deriveHyperliquidAddress(PHRASE));
  });

  it('refuses to derive on a path that is not one', () => {
    expect(() => deriveHyperliquidWallet(PHRASE, "m/44'/60'/x")).toThrow();
  });

  it('knows a bip-32 path', () => {
    for (const ok of [HYPERLIQUID_DEFAULT_PATH, "m/44'/60'/2000'/1/0", 'm/0', "m/2147483647'"]) {
      expect(isBip32Path(ok)).toBe(true);
    }
    for (const bad of [
      '',
      'm',
      'm/',
      "44'/60'/0'/0/0",
      "m/44'/60'/0'/0/0/",
      'm/44h/60h/0h/0/0',
      "m/44'/-1",
      "m/2147483648'",
      'm/1/2/3/4/5/6/7/8/9/10/11',
      " m/44'/60'/0'/0/0",
    ]) {
      expect(isBip32Path(bad)).toBe(false);
    }
  });

  it('falls back to the default for anything stored that is not a path', () => {
    expect(hyperliquidPath("m/44'/60'/2000'/1/0")).toBe("m/44'/60'/2000'/1/0");
    for (const bad of [undefined, null, 7, 'nonsense']) {
      expect(hyperliquidPath(bad)).toBe(HYPERLIQUID_DEFAULT_PATH);
    }
  });
});
