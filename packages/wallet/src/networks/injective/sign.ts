/**
 * Injective (Ethermint) signing.
 *
 * Ethermint diverges from standard cosmos signing in two ways, both handled
 * here:
 *   1. The digest is keccak256(signBytes), NOT sha256(signBytes).
 *   2. The account's public key is announced under the type URL
 *      `/injective.crypto.v1beta1.ethsecp256k1.PubKey` (the message wire format
 *      is identical to cosmos secp256k1 PubKey - a single `bytes key = 1` - only
 *      the type URL differs).
 *
 * The signature itself is ordinary secp256k1 ECDSA, low-S, returned as the
 * 64-byte `r || s` the cosmos `TxRaw.signatures` field expects (no recovery
 * byte). This matches Keplr's `PrivKeySecp256k1.signDigest32` ({ lowS: true }).
 *
 * Scope: this covers signing a SignDoc for the two transactions the receive-
 * and-shield conduit needs (IBC MsgTransfer in, bank MsgSend out). It does not
 * build the SignDoc - the caller assembles TxBody/AuthInfo and passes the
 * canonical sign bytes.
 */

import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';

/** The Any type URL Injective expects for an eth_secp256k1 account pubkey. */
export const ETHSECP256K1_PUBKEY_TYPE_URL = '/injective.crypto.v1beta1.ethsecp256k1.PubKey';

/**
 * Sign cosmos SignDoc bytes the Ethermint way.
 *
 * digest = keccak256(signBytes); ECDSA secp256k1, low-S; returned as 64 bytes
 * `r(32) || s(32)`. `privKey` must be zeroed by the caller after use.
 */
export function signEthSecp256k1(privKey: Uint8Array, signBytes: Uint8Array): Uint8Array {
  const digest = keccak_256(signBytes);
  const sig = secp256k1.sign(digest, privKey, { lowS: true });
  return sig.toBytes('compact'); // 64 bytes, r || s - no recovery id
}

/**
 * Protobuf-encode the ethsecp256k1 `PubKey { bytes key = 1 }` message body.
 * Wire-identical to cosmos secp256k1 PubKey; pair it with
 * `ETHSECP256K1_PUBKEY_TYPE_URL` in the Any.
 */
export function encodeEthSecp256k1PubKey(compressedPubKey: Uint8Array): Uint8Array {
  if (compressedPubKey.length !== 33) {
    throw new Error(`expected a 33-byte compressed secp256k1 pubkey, got ${compressedPubKey.length}`);
  }
  const out = new Uint8Array(2 + compressedPubKey.length);
  out[0] = 0x0a; // field 1, wire type 2 (length-delimited)
  out[1] = compressedPubKey.length; // 33 (< 128, single-byte varint)
  out.set(compressedPubKey, 2);
  return out;
}

/** The account pubkey as a protobuf Any, ready for AuthInfo.signer_infos. */
export function ethSecp256k1PubKeyAny(compressedPubKey: Uint8Array): {
  typeUrl: string;
  value: Uint8Array;
} {
  return {
    typeUrl: ETHSECP256K1_PUBKEY_TYPE_URL,
    value: encodeEthSecp256k1PubKey(compressedPubKey),
  };
}
