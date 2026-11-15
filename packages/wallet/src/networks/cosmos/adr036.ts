/**
 * ADR-036 off-chain signatures, as Keplr's signArbitrary / verifyArbitrary
 * make them. The signed bytes are an amino StdSignDoc that can never be a
 * transaction: one sign/MsgSignData {signer, data (base64)}, empty chain id
 * and memo, no fee, zero gas, account number and sequence 0.
 *
 * No cosmjs wallet code here, so the service worker can verify with it.
 */

import { fromBase64, fromBech32, toBase64, toHex } from '@cosmjs/encoding';
import { secp256k1 } from '@noble/curves/secp256k1';
import { ripemd160 } from '@noble/hashes/legacy';
import { sha256 } from '@noble/hashes/sha2';

/** the sign doc an ADR-036 signature covers, keys already in canonical order */
export const adr036SignDoc = (signer: string, data: Uint8Array) => ({
  account_number: '0',
  chain_id: '',
  fee: { amount: [] as { denom: string; amount: string }[], gas: '0' },
  memo: '',
  msgs: [{ type: 'sign/MsgSignData', value: { data: toBase64(data), signer } }],
  sequence: '0',
});

/** a signature as Keplr returns it */
export interface StdSignatureWire {
  pub_key: { type: string; value: string };
  signature: string;
}

/**
 * True when `signature` is `signer`'s ADR-036 signature over `data`: the
 * signer has `prefix`, its public key hashes to the signer's address, and the
 * signature is a low-s secp256k1 signature over sha256 of the sign doc.
 */
export function verifyAdr036(
  prefix: string,
  signer: string,
  data: Uint8Array,
  signature: StdSignatureWire,
): boolean {
  try {
    const address = fromBech32(signer);
    if (address.prefix !== prefix || signature.pub_key.type !== 'tendermint/PubKeySecp256k1') {
      return false;
    }
    const pubkey = fromBase64(signature.pub_key.value);
    if (toHex(ripemd160(sha256(pubkey))) !== toHex(address.data)) {
      return false;
    }
    const doc = new TextEncoder().encode(JSON.stringify(adr036SignDoc(signer, data)));
    return secp256k1.verify(fromBase64(signature.signature), sha256(doc), pubkey);
  } catch {
    return false;
  }
}

/** the message as a person reads it: utf-8 text when printable, else hex */
export function describeArbitraryData(data: Uint8Array): { text: string; hex: boolean } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    // eslint-disable-next-line no-control-regex -- control characters are what this looks for
    if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)) {
      return { text, hex: false };
    }
  } catch {
    // not utf-8
  }
  return { text: toHex(data), hex: true };
}
