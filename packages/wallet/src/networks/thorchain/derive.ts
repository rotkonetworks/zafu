/**
 * THORChain keys: secp256k1 on BIP44 coin type 931, path m/44'/931'/0'/0/{i}
 * (THORNode cmd/constants.go THORChainHDPath), with the plain cosmos address
 * ripemd160(sha256(compressed pubkey)) under the bech32 prefix `thor`.
 *
 * Derived here on its own explicit path, never through the cosmos signer:
 * `thor` has no row in COSMOS_CHAINS, so deriveCosmosWallet would fall back to
 * coin type 118 and produce a valid-looking address nobody holds the key to.
 * derive.test.ts pins THORNode's own "dog" mnemonic address (genesis.sh,
 * stagenet compose), which is the fund-safety gate for this module.
 *
 * zafu uses one such account per pocket, only inside the liquidity page,
 * after the person chose to add with rune too.
 */

import { mnemonicToSeedSync } from 'bip39';
import { sha256 } from '@noble/hashes/sha2';
import { ripemd160 } from '@noble/hashes/legacy';
import { secp256k1 } from '@noble/curves/secp256k1';
import { fromBech32, toBech32 } from '@cosmjs/encoding';
import { bip32DeriveSecp256k1 } from '../ethereum/derive';

export const THOR_PREFIX = 'thor';
export const THOR_COIN_TYPE = 931;
export const THOR_CHAIN_ID = 'thorchain-1';
/** rune, 1e8 */
export const RUNE_DECIMALS = 8;

export const thorPath = (index: number): string => {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 0x80000000) {
    throw new Error(`thorchain index ${index} is not valid`);
  }
  return `m/44'/${THOR_COIN_TYPE}'/0'/0/${index}`;
};

export interface ThorKey {
  /** bech32 `thor1...` */
  address: string;
  /** compressed secp256k1 public key, 33 bytes */
  publicKey: Uint8Array;
  /** secp256k1 private key, 32 bytes; the caller zeroes it after use */
  privateKey: Uint8Array;
}

/** the 20 address bytes of a compressed pubkey, the cosmos way */
export const thorAddressBytes = (publicKey: Uint8Array): Uint8Array => ripemd160(sha256(publicKey));

export const thorAddressOf = (publicKey: Uint8Array, prefix = THOR_PREFIX): string =>
  toBech32(prefix, thorAddressBytes(publicKey));

/** a well-formed `thor1` account address: checksum, prefix and a 20-byte payload */
export const isThorAddress = (address: string): boolean => {
  try {
    const { prefix, data } = fromBech32(address);
    return prefix === THOR_PREFIX && data.length === 20;
  } catch {
    return false;
  }
};

/** the account bytes a MsgDeposit's `signer` carries */
export const thorAccountBytes = (address: string): Uint8Array => {
  const { prefix, data } = fromBech32(address);
  if (prefix !== THOR_PREFIX || data.length !== 20) {
    throw new Error('not a thorchain account address');
  }
  return data;
};

export const deriveThorKey = (mnemonic: string, index: number, prefix = THOR_PREFIX): ThorKey => {
  // bip39 hands back a Buffer; noble wants a plain Uint8Array
  const seed = Uint8Array.from(mnemonicToSeedSync(mnemonic));
  const { privateKey, chainCode } = bip32DeriveSecp256k1(seed, thorPath(index));
  seed.fill(0);
  chainCode.fill(0);
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  return { address: thorAddressOf(publicKey, prefix), publicKey, privateKey };
};

/** just the address; the private key is wiped before this returns */
export const deriveThorAddress = (mnemonic: string, index: number): string => {
  const k = deriveThorKey(mnemonic, index);
  k.privateKey.fill(0);
  return k.address;
};
