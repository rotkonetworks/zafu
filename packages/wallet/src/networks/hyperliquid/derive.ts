/**
 * The Hyperliquid key: by default the wallet's one EVM key (m/44'/60'/0'/0/0,
 * the key Injective and the Base buy already use), so a person has one 0x
 * address. Someone whose Hyperliquid account sits on another path names it.
 */

import { deriveEthWalletAtPath, type EthWallet } from '../ethereum/derive';

export const HYPERLIQUID_DEFAULT_PATH = "m/44'/60'/0'/0/0";

const HARDENED = 0x80000000;

/** `m/44'/60'/2000'/1/0`: one to ten indices under 2^31, each plain or hardened with `'` */
export const isBip32Path = (path: string): boolean =>
  /^m(\/\d{1,10}'?){1,10}$/.test(path) &&
  path
    .slice(2)
    .split('/')
    .every(s => parseInt(s, 10) < HARDENED);

/** the stored path when it is a valid one, else the default */
export const hyperliquidPath = (stored: unknown): string =>
  typeof stored === 'string' && isBip32Path(stored) ? stored : HYPERLIQUID_DEFAULT_PATH;

/**
 * The key at `path`, its address lowercased as Hyperliquid asks for every
 * address it is sent. The caller zeroes `privateKey` after use.
 */
export function deriveHyperliquidWallet(
  mnemonic: string,
  path = HYPERLIQUID_DEFAULT_PATH,
): EthWallet {
  if (!isBip32Path(path)) {
    throw new Error(`not a derivation path: ${path}`);
  }
  const wallet = deriveEthWalletAtPath(mnemonic, path);
  return { ...wallet, address: wallet.address.toLowerCase() };
}

/** just the address; the key is zeroed here */
export function deriveHyperliquidAddress(mnemonic: string, path?: string): string {
  const wallet = deriveHyperliquidWallet(mnemonic, path);
  wallet.privateKey.fill(0);
  return wallet.address;
}
