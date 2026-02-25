/**
 * zcash transparent address derivation (BIP32-secp256k1)
 *
 * derives t1 addresses from mnemonic using BIP44 path: m/44'/133'/account'/0/index
 * uses the same noble libraries already used for polkadot SLIP-10 derivation
 */

import { mnemonicToSeedSync } from 'bip39';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { secp256k1 } from '@noble/curves/secp256k1';

/** secp256k1 curve order */
const N = secp256k1.CURVE.n;

/** base58 alphabet (bitcoin style) */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Uint8Array): string {
  let leadingZeros = 0;
  for (const b of bytes) {
    if (b === 0) leadingZeros++;
    else break;
  }

  let num = BigInt(0);
  for (const b of bytes) {
    num = num * 256n + BigInt(b);
  }

  let result = '';
  while (num > 0n) {
    result = BASE58_ALPHABET[Number(num % 58n)] + result;
    num = num / 58n;
  }

  return '1'.repeat(leadingZeros) + result;
}

/** base58check: payload + first 4 bytes of double-SHA256 */
function base58check(payload: Uint8Array): string {
  const checksum = sha256(sha256(payload)).slice(0, 4);
  const full = new Uint8Array(payload.length + 4);
  full.set(payload);
  full.set(checksum, payload.length);
  return base58Encode(full);
}

/** serialize uint32 big-endian */
function ser32(n: number): Uint8Array {
  const buf = new Uint8Array(4);
  const view = new DataView(buf.buffer);
  view.setUint32(0, n, false);
  return buf;
}

/** parse 32 bytes as bigint */
function parse256(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) {
    n = (n << 8n) | BigInt(b);
  }
  return n;
}

/** bigint to 32-byte big-endian Uint8Array */
function bigintTo32Bytes(n: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let val = n;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return bytes;
}

/** compressed public key from private key */
function compressedPubkey(privateKey: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(privateKey, true);
}

/**
 * BIP32 key derivation for secp256k1
 * see: https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki
 */
function bip32DeriveSecp256k1(
  seed: Uint8Array,
  path: string,
): { privateKey: Uint8Array; chainCode: Uint8Array } {
  // master key from seed
  const I = hmac(sha512, 'Bitcoin seed', seed);
  let privateKey: Uint8Array = I.slice(0, 32);
  let chainCode: Uint8Array = I.slice(32);

  // validate master key
  const kp = parse256(privateKey);
  if (kp === 0n || kp >= N) {
    throw new Error('invalid master key');
  }

  // parse path segments
  const segments = path
    .replace(/^m\//, '')
    .split('/')
    .filter(s => s.length > 0);

  for (const segment of segments) {
    const hardened = segment.endsWith("'");
    const index = parseInt(segment.replace("'", ''), 10);

    let data: Uint8Array;
    if (hardened) {
      // hardened: 0x00 || ser256(kpar) || ser32(index + 0x80000000)
      data = new Uint8Array(1 + 32 + 4);
      data[0] = 0x00;
      data.set(privateKey, 1);
      data.set(ser32(index + 0x80000000), 33);
    } else {
      // non-hardened: serP(point(kpar)) || ser32(index)
      const pubkey = compressedPubkey(privateKey);
      data = new Uint8Array(33 + 4);
      data.set(pubkey, 0);
      data.set(ser32(index), 33);
    }

    const childI = hmac(sha512, chainCode, data);
    const IL = parse256(childI.slice(0, 32));
    const parentKey = parse256(privateKey);

    const childKey = (IL + parentKey) % N;
    if (IL >= N || childKey === 0n) {
      throw new Error('invalid child key — increment index and retry');
    }

    privateKey = bigintTo32Bytes(childKey);
    chainCode = childI.slice(32);
  }

  return { privateKey, chainCode };
}

/**
 * zcash transparent address version bytes
 * mainnet t1: [0x1C, 0xB8]
 * testnet t1: [0x1D, 0x25]
 */
const ZCASH_T_ADDR_VERSION = {
  mainnet: new Uint8Array([0x1c, 0xb8]),
  testnet: new Uint8Array([0x1d, 0x25]),
} as const;

/** encode compressed pubkey as zcash transparent (t1) address */
function encodeTransparentAddress(pubkey: Uint8Array, mainnet: boolean): string {
  const hash = ripemd160(sha256(pubkey));
  const version = mainnet ? ZCASH_T_ADDR_VERSION.mainnet : ZCASH_T_ADDR_VERSION.testnet;
  const payload = new Uint8Array(version.length + hash.length);
  payload.set(version);
  payload.set(hash, version.length);
  return base58check(payload);
}

/**
 * derive zcash transparent address from mnemonic
 *
 * BIP44 path: m/44'/133'/account'/0/index
 * each index gives a unique address — use one per exchange/purpose
 */
export function deriveZcashTransparentAddress(
  mnemonic: string,
  account: number,
  index: number,
  mainnet = true,
): string {
  const seed = mnemonicToSeedSync(mnemonic);
  const path = `m/44'/133'/${account}'/0/${index}`;
  const { privateKey } = bip32DeriveSecp256k1(seed, path);
  const pubkey = compressedPubkey(privateKey);

  // clear private key from memory
  privateKey.fill(0);

  return encodeTransparentAddress(pubkey, mainnet);
}
