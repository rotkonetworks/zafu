/**
 * Injective (Ethermint) key derivation.
 *
 * Injective is NOT a standard cosmos chain. It is Ethermint:
 *   - BIP44 coin type 60 (Ethereum), path m/44'/60'/0'/0/{index}
 *   - secp256k1 keys, but the ADDRESS is Ethereum-style:
 *       keccak256(uncompressed_pubkey[1:])[-20:]  (last 20 bytes)
 *     bech32-encoded with the `inj` prefix - NOT the cosmos
 *     ripemd160(sha256(compressed_pubkey)) scheme.
 *
 * This is the same derivation Keplr uses (its `PubKeySecp256k1.getEthAddress`
 * is byte-identical), and it is verified against Keplr's own reference vector
 * in derive.test.ts. Getting this wrong produces a valid-looking but WRONG
 * inj1 address, so the test is the fund-safety gate - never ship a change here
 * without it passing.
 *
 * Scope note: Injective exists in this wallet only as a USDC receive-and-shield
 * conduit into Penumbra, so this module derives the account; signing is limited
 * to an IBC MsgTransfer (shield-in) and a bank MsgSend (withdraw), handled by
 * the signer with an eth_secp256k1 (keccak-digest) signature.
 */

import { toBech32, fromBech32 } from '@cosmjs/encoding';
import { keccak_256 } from '@noble/hashes/sha3';
import { deriveEthWallet } from '../ethereum/derive';

/** Injective bech32 human-readable prefix. */
export const INJECTIVE_PREFIX = 'inj';

/**
 * Real bech32-checksum validation for an Injective address, for the withdraw
 * destination. fromBech32 rejects a bad checksum or malformed bech32 (a mistyped
 * or truncated address a `startsWith('inj1')` check would wave through); we then
 * require the `inj` prefix and a 20-byte payload (the Ethermint account id
 * width). This does NOT prove the address is an exchange USDC-on-Injective
 * deposit address - only that it is a well-formed inj address; the panel keeps
 * the amber network-mismatch warning alongside it.
 */
export function isValidInjectiveAddress(address: string): boolean {
  try {
    const { prefix, data } = fromBech32(address.trim());
    return prefix === INJECTIVE_PREFIX && data.length === 20;
  } catch {
    return false;
  }
}

/** Why a pasted recipient can't be used, short enough to show under the field. */
export type InjectiveRecipientProblem =
  | 'penumbra' // a Penumbra address: this sends on Injective, not into Penumbra
  | 'other-chain' // valid bech32 for another chain (cosmos1, osmo1, noble1...)
  | 'checksum' // looks like an address but a character is wrong
  | 'format'; // not an address

export type InjectiveRecipient =
  | { ok: true; address: string; fromHex: boolean }
  | { ok: false; problem: InjectiveRecipientProblem; prefix?: string };

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** EIP-55: a mixed-case 0x address carries a checksum in its letter case. */
const eip55Valid = (hex: string): boolean => {
  const body = hex.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) {
    return true; // single-case: no checksum to verify
  }
  const hash = keccak_256(new TextEncoder().encode(body.toLowerCase()));
  for (let i = 0; i < 40; i++) {
    const nibble = (hash[i >> 1]! >> (i % 2 === 0 ? 4 : 0)) & 0xf;
    const ch = body[i]!;
    if (/[a-f]/i.test(ch) && nibble >= 8 !== (ch === ch.toUpperCase())) {
      return false;
    }
  }
  return true;
};

/**
 * Parse a pasted Injective recipient. Accepts `inj1...` (bech32, checked) and
 * the same account as a `0x...` address (what Coinbase and Injective's EVM
 * side show; EIP-55 checked when mixed-case), returning the `inj1` form to
 * send to. On failure says what was pasted instead, so the UI can name it.
 */
export function parseInjectiveRecipient(input: string): InjectiveRecipient {
  const text = input.trim();
  if (HEX_ADDRESS.test(text)) {
    if (!eip55Valid(text)) {
      return { ok: false, problem: 'checksum' };
    }
    const bytes = Uint8Array.from(text.slice(2).match(/../g)!, h => parseInt(h, 16));
    return { ok: true, address: toBech32(INJECTIVE_PREFIX, bytes), fromHex: true };
  }
  if (/^penumbra1/i.test(text) || /^penumbracompat1/i.test(text)) {
    return { ok: false, problem: 'penumbra' };
  }
  try {
    const { prefix, data } = fromBech32(text);
    if (prefix !== INJECTIVE_PREFIX) {
      return { ok: false, problem: 'other-chain', prefix };
    }
    return data.length === 20
      ? { ok: true, address: text.toLowerCase(), fromHex: false }
      : { ok: false, problem: 'format' };
  } catch {
    return /^inj1[02-9ac-hj-np-z]{20,}$/i.test(text)
      ? { ok: false, problem: 'checksum' }
      : { ok: false, problem: 'format' };
  }
}

export interface InjectiveWallet {
  /** bech32 `inj1...` address */
  address: string;
  /** the 20-byte Ethereum-style account id (before bech32) */
  addressBytes: Uint8Array;
  /** compressed secp256k1 public key (33 bytes) */
  publicKey: Uint8Array;
  /** secp256k1 private key (32 bytes) - caller must zero it after use */
  privateKey: Uint8Array;
}

/** the 20 address bytes out of deriveEthWallet's `0x`-checksummed string. */
const addressBytesFromEth = (hex0x: string): Uint8Array => {
  const hex = hex0x.replace(/^0x/, '');
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

/** Derive an Injective account from a mnemonic (coin type 60, eth address). */
export async function deriveInjectiveWallet(
  mnemonic: string,
  accountIndex = 0,
): Promise<InjectiveWallet> {
  const eth = await deriveEthWallet(mnemonic, accountIndex);
  const addressBytes = addressBytesFromEth(eth.address);
  return {
    address: toBech32(INJECTIVE_PREFIX, addressBytes),
    addressBytes,
    publicKey: eth.publicKey,
    privateKey: eth.privateKey,
  };
}

/** Derive just the `inj1...` address (zeroes the private key). */
export async function deriveInjectiveAddress(mnemonic: string, accountIndex = 0): Promise<string> {
  const wallet = await deriveInjectiveWallet(mnemonic, accountIndex);
  wallet.privateKey.fill(0);
  return wallet.address;
}
