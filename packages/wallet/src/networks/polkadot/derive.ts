/**
 * polkadot key derivation using ed25519
 *
 * uses SLIP-10 derivation for ed25519 (different from BIP32-secp256k1)
 * compatible with ledger ed25519 derivation path: m/44'/354'/0'/0'/0'
 *
 * for sr25519 keys, users should import via Zigner (requires schnorrkel WASM)
 */

import { mnemonicToSeedSync } from 'bip39';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';
import { ed25519 } from '@noble/curves/ed25519';
import { blake2b } from '@noble/hashes/blake2b';

/** SS58 address format prefixes */
const SS58_PREFIX = {
  polkadot: 0,
  kusama: 2,
} as const;

type SubstrateNetwork = keyof typeof SS58_PREFIX;

/** derived polkadot wallet (ed25519) */
export interface PolkadotWallet {
  address: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  network: SubstrateNetwork;
}

/**
 * SLIP-10 ed25519 key derivation
 * see: https://github.com/satoshilabs/slips/blob/master/slip-0010.md
 */
function slip10DeriveEd25519(seed: Uint8Array, path: string): { privateKey: Uint8Array; chainCode: Uint8Array } {
  // master key
  const I = hmac(sha512, 'ed25519 seed', seed);
  let privateKey = I.slice(0, 32);
  let chainCode = I.slice(32);

  // parse path
  const segments = path
    .replace(/^m\//, '')
    .split('/')
    .filter(s => s.length > 0);

  for (const segment of segments) {
    const hardened = segment.endsWith("'");
    const index = parseInt(segment.replace("'", ''), 10);

    if (!hardened) {
      throw new Error('ed25519 SLIP-10 only supports hardened derivation');
    }

    // hardened child derivation
    const indexBuf = new Uint8Array(4);
    const view = new DataView(indexBuf.buffer);
    view.setUint32(0, index + 0x80000000, false); // big endian

    const data = new Uint8Array(1 + 32 + 4);
    data[0] = 0x00;
    data.set(privateKey, 1);
    data.set(indexBuf, 33);

    const childI = hmac(sha512, chainCode, data);
    privateKey = childI.slice(0, 32);
    chainCode = childI.slice(32);
  }

  return { privateKey, chainCode };
}

/**
 * encode public key as SS58 address
 */
function encodeAddress(publicKey: Uint8Array, ss58Format: number): string {
  const SS58_PREFIX_BYTES = new TextEncoder().encode('SS58PRE');

  // for simple format (0-63), use single byte
  const prefixBytes = ss58Format < 64
    ? new Uint8Array([ss58Format])
    : new Uint8Array([
        ((ss58Format & 0xfc) >> 2) | 0x40,
        (ss58Format >> 8) | ((ss58Format & 0x03) << 6),
      ]);

  // payload = prefix + publicKey
  const payload = new Uint8Array(prefixBytes.length + publicKey.length);
  payload.set(prefixBytes);
  payload.set(publicKey, prefixBytes.length);

  // checksum = blake2b(SS58PRE + payload, 64)[0..1]
  const checksumInput = new Uint8Array(SS58_PREFIX_BYTES.length + payload.length);
  checksumInput.set(SS58_PREFIX_BYTES);
  checksumInput.set(payload, SS58_PREFIX_BYTES.length);
  const checksum = blake2b(checksumInput, { dkLen: 64 }).slice(0, 2);

  // result = base58(payload + checksum)
  const full = new Uint8Array(payload.length + 2);
  full.set(payload);
  full.set(checksum, payload.length);

  return base58Encode(full);
}

/** base58 alphabet (bitcoin style) */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Uint8Array): string {
  // count leading zeros
  let leadingZeros = 0;
  for (const b of bytes) {
    if (b === 0) leadingZeros++;
    else break;
  }

  // convert to bigint
  let num = BigInt(0);
  for (const b of bytes) {
    num = num * BigInt(256) + BigInt(b);
  }

  // convert to base58
  let result = '';
  while (num > 0) {
    result = BASE58_ALPHABET[Number(num % BigInt(58))] + result;
    num = num / BigInt(58);
  }

  // add leading '1's for zeros
  return '1'.repeat(leadingZeros) + result;
}

/**
 * derive polkadot/kusama ed25519 wallet from mnemonic
 *
 * uses ledger-compatible derivation: m/44'/354'/0'/0'/0' for polkadot
 * this matches Ledger app derivation so addresses are identical
 */
export async function derivePolkadotWallet(
  mnemonic: string,
  network: SubstrateNetwork = 'polkadot',
  accountIndex = 0
): Promise<PolkadotWallet> {
  // convert mnemonic to seed
  const seed = mnemonicToSeedSync(mnemonic);

  // derivation path based on network
  // polkadot: m/44'/354'/account'/0'/0'
  // kusama: m/44'/434'/account'/0'/0'
  const coinType = network === 'polkadot' ? 354 : 434;
  const path = `m/44'/${coinType}'/${accountIndex}'/0'/0'`;

  // derive ed25519 key using SLIP-10
  const { privateKey } = slip10DeriveEd25519(seed, path);

  // get public key from private key
  const publicKey = ed25519.getPublicKey(privateKey);

  // encode as SS58 address
  const ss58Format = SS58_PREFIX[network];
  const address = encodeAddress(publicKey, ss58Format);

  return {
    address,
    publicKey,
    privateKey,
    network,
  };
}

/**
 * derive just the address (no private key returned)
 * useful for display purposes
 */
export async function derivePolkadotAddress(
  mnemonic: string,
  network: SubstrateNetwork = 'polkadot',
  accountIndex = 0
): Promise<string> {
  const wallet = await derivePolkadotWallet(mnemonic, network, accountIndex);
  // clear private key from memory
  wallet.privateKey.fill(0);
  return wallet.address;
}
