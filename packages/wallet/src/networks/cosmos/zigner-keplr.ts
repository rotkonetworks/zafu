/**
 * Keplr requests answered by a Zigner wallet. Its key is the cosmos public
 * key zigner exported (33-byte compressed secp256k1, coin type 118), so the
 * address on any chain is derived from it, never taken on trust. Signing goes
 * through the cosmos sign QR (airgap.ts); zigner's 64-byte r||s answer is
 * checked against that key and the exact sign doc before a site sees it.
 */

import {
  encodeSecp256k1Pubkey,
  pubkeyToAddress,
  serializeSignDoc,
  type StdSignDoc,
} from '@cosmjs/amino';
import { fromBase64, fromBech32, fromHex, toBase64 } from '@cosmjs/encoding';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { encodeCosmosSignRequest } from './airgap';
import type { StdSignatureWire } from './adr036';

const KEY_HEX = /^0[23][0-9a-f]{64}$/i;

/** what Keplr's getKey answers, for a zigner key on `prefix`; null without a usable key */
export function zignerKeplrKey(publicKeyHex: string | undefined, prefix: string, name: string) {
  if (!publicKeyHex || !KEY_HEX.test(publicKeyHex)) {
    return null;
  }
  const pubkey = fromHex(publicKeyHex);
  const bech32Address = pubkeyToAddress(encodeSecp256k1Pubkey(pubkey), prefix);
  return {
    name,
    algo: 'secp256k1',
    pubKeyB64: toBase64(pubkey),
    addressB64: toBase64(fromBech32(bech32Address).data),
    bech32Address,
  };
}

/** the QR zigner signs `doc` from: its canonical amino bytes, as for a zigner send */
export const zignerAminoRequest = (accountIndex: number, chainName: string, doc: StdSignDoc) =>
  encodeCosmosSignRequest(accountIndex, chainName, serializeSignDoc(doc));

/**
 * Zigner's answer for `doc`, as Keplr returns a signature. Throws unless the
 * key owns `signer` and `signature` is a low-s signature over sha256 of the
 * doc's canonical bytes: a code from another request, or another key's, never
 * reaches the site.
 */
export function zignerAminoSignature(
  publicKeyHex: string | undefined,
  signer: string,
  doc: StdSignDoc,
  signature: Uint8Array,
): StdSignatureWire {
  const key = zignerKeplrKey(publicKeyHex, fromBech32(signer).prefix, '');
  if (key?.bech32Address !== signer) {
    throw new Error(`this zigner key does not own ${signer}`);
  }
  if (!secp256k1.verify(signature, sha256(serializeSignDoc(doc)), fromBase64(key.pubKeyB64))) {
    throw new Error("that answer isn't zigner's signature for this request · please scan again");
  }
  return {
    pub_key: { type: 'tendermint/PubKeySecp256k1', value: key.pubKeyB64 },
    signature: toBase64(signature),
  };
}
