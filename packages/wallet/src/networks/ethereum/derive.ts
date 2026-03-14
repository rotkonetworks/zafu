/**
 * ethereum key derivation using BIP-44
 *
 * uses BIP-32 (secp256k1) HD derivation with path m/44'/60'/0'/0/{index}
 * address = keccak256(uncompressedPubkey[1:])[12:]  (EIP-55 checksummed)
 */

import { mnemonicToSeedSync } from 'bip39';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';

/** derived ethereum wallet */
export interface EthWallet {
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
  // master key from seed
  const I = hmac(sha512, 'Bitcoin seed', seed);
  let privateKey = I.slice(0, 32);
  let chainCode = I.slice(32);

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
      // hardened child: 0x00 || ser256(kpar) || ser32(i + 0x80000000)
      data = new Uint8Array(1 + 32 + 4);
      data[0] = 0x00;
      data.set(privateKey, 1);
      const view = new DataView(data.buffer, data.byteOffset);
      view.setUint32(33, (index + 0x80000000) >>> 0, false);
    } else {
      // normal child: serP(point(kpar)) || ser32(i)
      const pubkey = secp256k1.getPublicKey(privateKey, true); // compressed 33 bytes
      data = new Uint8Array(33 + 4);
      data.set(pubkey, 0);
      const view = new DataView(data.buffer, data.byteOffset);
      view.setUint32(33, index, false);
    }

    const childI = hmac(sha512, chainCode, data);
    const childKey = childI.slice(0, 32);
    const childChainCode = childI.slice(32);

    // child key = parse256(IL) + kpar (mod n)
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
 * EIP-55 mixed-case checksum encoding
 */
function toChecksumAddress(address: string): string {
  const lower = address.toLowerCase().replace('0x', '');
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)));

  let checksummed = '0x';
  for (let i = 0; i < lower.length; i++) {
    if (parseInt(hash[i]!, 16) >= 8) {
      checksummed += lower[i]!.toUpperCase();
    } else {
      checksummed += lower[i];
    }
  }
  return checksummed;
}

/**
 * derive ethereum wallet from mnemonic
 *
 * BIP-44 path: m/44'/60'/0'/0/{accountIndex}
 */
export async function deriveEthWallet(
  mnemonic: string,
  accountIndex = 0,
): Promise<EthWallet> {
  const seed = mnemonicToSeedSync(mnemonic);
  const path = `m/44'/60'/0'/0/${accountIndex}`;

  const { privateKey } = bip32DeriveSecp256k1(seed, path);

  // get uncompressed public key (65 bytes: 0x04 || x || y)
  const uncompressedPubkey = secp256k1.getPublicKey(privateKey, false);

  // address = last 20 bytes of keccak256(pubkey[1:])
  const hash = keccak_256(uncompressedPubkey.slice(1));
  const addressBytes = hash.slice(12);
  const address = toChecksumAddress('0x' + bytesToHex(addressBytes));

  return {
    address,
    publicKey: secp256k1.getPublicKey(privateKey, true), // compressed for storage
    privateKey,
  };
}

/**
 * derive just the address (no private key returned)
 */
export async function deriveEthAddress(
  mnemonic: string,
  accountIndex = 0,
): Promise<string> {
  const wallet = await deriveEthWallet(mnemonic, accountIndex);
  wallet.privateKey.fill(0);
  return wallet.address;
}
