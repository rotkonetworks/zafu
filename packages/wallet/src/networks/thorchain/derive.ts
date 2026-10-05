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
import { hkdf } from '@noble/hashes/hkdf';
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

/** a key from 32 raw bytes (a random key zafu made at opt-in), as hex */
export const thorKeyFromHex = (hex: string, prefix = THOR_PREFIX): ThorKey => {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error('this rune key is not well formed');
  }
  const privateKey = hexBytes(hex);
  if (!secp256k1.utils.isValidSecretKey(privateKey)) {
    privateKey.fill(0);
    throw new Error('this rune key is not well formed');
  }
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  return { address: thorAddressOf(publicKey, prefix), publicKey, privateKey };
};

/** a fresh random key for a cold wallet's rune account, as hex; the caller seals it at once */
export const randomThorKeyHex = (): string => {
  const k = secp256k1.utils.randomSecretKey();
  const hex = Array.from(k, b => b.toString(16).padStart(2, '0')).join('');
  k.fill(0);
  return hex;
};

/** the HKDF info prefix of a viewing-key rune account; v1 is fixed forever */
export const FVK_RUNE_INFO = 'zafu-thorchain-rune-v1';

const N = secp256k1.Point.CURVE().n;

const hexBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

/**
 * A rune key from a wallet's viewing key, for cold wallets that chose it.
 * Anyone holding the viewing key can derive this key: it is a convenience,
 * not custody, and the page says so.
 *
 * Precisely (reproducible with any HKDF-SHA256 and secp256k1):
 *   ikm   = UTF-8 bytes of the wallet's unified full viewing key string
 *           (`uview1...`) exactly as zafu stores it: its `ufvk`, or its
 *           `orchardFvk` when that field holds the uview string
 *   salt  = empty
 *   info  = ASCII "zafu-thorchain-rune-v1" || uint32 big-endian(index)
 *   okm   = HKDF-SHA256(ikm, salt, info, 48 bytes)
 *   d     = (okm as a big-endian integer mod (n - 1)) + 1, n the secp256k1 order
 *   key   = d as 32 big-endian bytes; address = bech32("thor", ripemd160(sha256(compressed d·G)))
 * 48 bytes reduced mod n-1 keeps the bias under 2^-128 (as RFC 9380 hash_to_field).
 */
export const deriveThorKeyFromFvk = (fvk: string, index: number, prefix = THOR_PREFIX): ThorKey => {
  if (!fvk || !Number.isSafeInteger(index) || index < 0 || index > 0xffffffff) {
    throw new Error('this viewing key or index is not valid');
  }
  const tag = new TextEncoder().encode(FVK_RUNE_INFO);
  const info = new Uint8Array(tag.length + 4);
  info.set(tag);
  new DataView(info.buffer).setUint32(tag.length, index, false);
  const okm = hkdf(sha256, new TextEncoder().encode(fvk), new Uint8Array(0), info, 48);
  let x = 0n;
  for (const b of okm) {
    x = (x << 8n) | BigInt(b);
  }
  okm.fill(0);
  const d = (x % (N - 1n)) + 1n;
  const privateKey = hexBytes(d.toString(16).padStart(64, '0'));
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  return { address: thorAddressOf(publicKey, prefix), publicKey, privateKey };
};
