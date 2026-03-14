/**
 * bitcoin key derivation using BIP-84 (native segwit)
 *
 * BIP-32 HD derivation with path m/84'/0'/0'/0/{index}
 * produces bech32 (bc1...) native segwit P2WPKH addresses
 */

import { mnemonicToSeedSync } from 'bip39';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { secp256k1 } from '@noble/curves/secp256k1';

/** derived bitcoin wallet */
export interface BitcoinWallet {
  address: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * BIP-32 secp256k1 HD key derivation
 */
function bip32DeriveSecp256k1(
  seed: Uint8Array,
  path: string,
): { privateKey: Uint8Array; chainCode: Uint8Array } {
  const I = hmac(sha512, 'Bitcoin seed', seed);
  let privateKey = I.slice(0, 32);
  let chainCode = I.slice(32);

  const segments = path
    .replace(/^m\//, '')
    .split('/')
    .filter(s => s.length > 0);

  for (const segment of segments) {
    const hardened = segment.endsWith("'");
    const index = parseInt(segment.replace("'", ''), 10);

    let data: Uint8Array;

    if (hardened) {
      data = new Uint8Array(1 + 32 + 4);
      data[0] = 0x00;
      data.set(privateKey, 1);
      const view = new DataView(data.buffer, data.byteOffset);
      view.setUint32(33, (index + 0x80000000) >>> 0, false);
    } else {
      const pubkey = secp256k1.getPublicKey(privateKey, true);
      data = new Uint8Array(33 + 4);
      data.set(pubkey, 0);
      const view = new DataView(data.buffer, data.byteOffset);
      view.setUint32(33, index, false);
    }

    const childI = hmac(sha512, chainCode, data);
    const childKey = childI.slice(0, 32);
    const childChainCode = childI.slice(32);

    const parentBigInt = BigInt('0x' + bytesToHex(privateKey));
    const childBigInt = BigInt('0x' + bytesToHex(childKey));
    const n = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
    const result = (parentBigInt + childBigInt) % n;

    const resultBytes = hexToBytes(result.toString(16).padStart(64, '0'));
    privateKey = new Uint8Array(resultBytes);
    chainCode = childChainCode;
  }

  return { privateKey, chainCode };
}

/** convert bytes to hex */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** convert hex to bytes */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * hash160 = ripemd160(sha256(data))
 * used for P2WPKH witness program
 */
function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

// --- bech32 encoding (BIP-173) ---

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((b >>> i) & 1) {
        chk ^= GEN[i]!;
      }
    }
  }
  return chk;
}

function bech32HrpExpand(hrp: string): number[] {
  const result: number[] = [];
  for (let i = 0; i < hrp.length; i++) {
    result.push(hrp.charCodeAt(i) >>> 5);
  }
  result.push(0);
  for (let i = 0; i < hrp.length; i++) {
    result.push(hrp.charCodeAt(i) & 31);
  }
  return result;
}

function bech32CreateChecksum(hrp: string, data: number[]): number[] {
  const values = [...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const polymod = bech32Polymod(values) ^ 1;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) {
    checksum.push((polymod >>> (5 * (5 - i))) & 31);
  }
  return checksum;
}

/** convert 8-bit bytes to 5-bit groups for bech32 */
function convertBits(data: Uint8Array, fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const result: number[] = [];
  const maxv = (1 << toBits) - 1;

  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((acc >>> bits) & maxv);
    }
  }

  if (pad) {
    if (bits > 0) {
      result.push((acc << (toBits - bits)) & maxv);
    }
  }

  return result;
}

/**
 * encode a segwit address (bech32)
 * witness version 0 for P2WPKH
 */
function encodeBech32Address(hrp: string, witnessVersion: number, witnessProgram: Uint8Array): string {
  const data5bit = convertBits(witnessProgram, 8, 5, true);
  const combined = [witnessVersion, ...data5bit];
  const checksum = bech32CreateChecksum(hrp, combined);
  const all = [...combined, ...checksum];

  let result = hrp + '1';
  for (const d of all) {
    result += BECH32_CHARSET[d];
  }
  return result;
}

/**
 * derive bitcoin native segwit wallet from mnemonic
 *
 * BIP-84 path: m/84'/0'/0'/0/{accountIndex}
 * produces bc1... (P2WPKH) addresses
 */
export async function deriveBtcWallet(
  mnemonic: string,
  accountIndex = 0,
): Promise<BitcoinWallet> {
  const seed = mnemonicToSeedSync(mnemonic);
  const path = `m/84'/0'/0'/0/${accountIndex}`;

  const { privateKey } = bip32DeriveSecp256k1(seed, path);

  // compressed public key (33 bytes)
  const publicKey = secp256k1.getPublicKey(privateKey, true);

  // P2WPKH witness program = hash160(compressed_pubkey)
  const witnessProgram = hash160(publicKey);

  // bech32 encode with witness version 0
  const address = encodeBech32Address('bc', 0, witnessProgram);

  return {
    address,
    publicKey,
    privateKey,
  };
}

/**
 * derive just the address (no private key returned)
 */
export async function deriveBtcAddress(
  mnemonic: string,
  accountIndex = 0,
): Promise<string> {
  const wallet = await deriveBtcWallet(mnemonic, accountIndex);
  wallet.privateKey.fill(0);
  return wallet.address;
}
