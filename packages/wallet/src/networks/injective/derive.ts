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

import { toBech32 } from '@cosmjs/encoding';
import { deriveEthWallet } from '../ethereum/derive';

/** Injective bech32 human-readable prefix. */
export const INJECTIVE_PREFIX = 'inj';

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
