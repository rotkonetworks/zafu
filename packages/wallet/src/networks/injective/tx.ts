/**
 * Injective transaction assembly.
 *
 * Builds a SIGN_MODE_DIRECT SignDoc for the receive-and-shield conduit's two
 * transactions (bank MsgSend out, IBC MsgTransfer in), signs it the Ethermint
 * way (see sign.ts), and assembles the TxRaw. Also decodes Injective's
 * EthAccount, which wraps the standard BaseAccount and which cosmjs's
 * getAccount cannot parse.
 *
 * The signature this produces is verifiable offline (see tx.test.ts), but
 * whether Injective ACCEPTS the tx must be proven with a testnet round-trip
 * before this is wired into the send flow - do not enable on the strength of
 * the offline tests alone.
 */

import { makeAuthInfoBytes, makeSignDoc } from '@cosmjs/proto-signing';
import { TxBody, TxRaw, SignDoc } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { SignMode } from 'cosmjs-types/cosmos/tx/signing/v1beta1/signing';
import { BaseAccount } from 'cosmjs-types/cosmos/auth/v1beta1/auth';
import type { Coin } from 'cosmjs-types/cosmos/base/v1beta1/coin';
import { signEthSecp256k1, ethSecp256k1PubKeyAny } from './sign';

/** A protobuf message ready for a TxBody (typeUrl + already-encoded value). */
export interface EncodedMsg {
  typeUrl: string;
  value: Uint8Array;
}

export interface BuildInjectiveTxParams {
  msgs: EncodedMsg[];
  fee: { amount: Coin[]; gas: string };
  memo?: string;
  /** compressed secp256k1 public key (33 bytes) */
  pubKey: Uint8Array;
  /** secp256k1 private key (32 bytes); caller zeroes it afterwards */
  privKey: Uint8Array;
  accountNumber: bigint;
  sequence: number;
  chainId: string;
}

/**
 * Build a fully-signed Injective TxRaw (protobuf bytes ready to broadcast).
 * The signature is over keccak256(SignDoc bytes) - the Ethermint scheme.
 */
export function buildSignedInjectiveTx(p: BuildInjectiveTxParams): Uint8Array {
  const bodyBytes = TxBody.encode(
    TxBody.fromPartial({ messages: p.msgs, memo: p.memo ?? '' }),
  ).finish();

  const authInfoBytes = makeAuthInfoBytes(
    [{ pubkey: ethSecp256k1PubKeyAny(p.pubKey), sequence: p.sequence }],
    p.fee.amount,
    Number(p.fee.gas),
    undefined,
    undefined,
    SignMode.SIGN_MODE_DIRECT,
  );

  const signDoc = makeSignDoc(bodyBytes, authInfoBytes, p.chainId, p.accountNumber);
  const signBytes = SignDoc.encode(signDoc).finish();
  const signature = signEthSecp256k1(p.privKey, signBytes);

  return TxRaw.encode(
    TxRaw.fromPartial({ bodyBytes, authInfoBytes, signatures: [signature] }),
  ).finish();
}

/**
 * Read the first protobuf field, expected to be field 1, wire type 2
 * (`base_account`). Varint length decoding is inherently bitwise.
 */
/* eslint-disable no-bitwise -- protobuf varint length decoding is inherently bitwise */
const readLengthDelimitedField1 = (buf: Uint8Array): Uint8Array => {
  if (buf[0] !== 0x0a) {
    throw new Error('unexpected EthAccount layout: base_account (field 1) not first');
  }
  let i = 1;
  let len = 0;
  let shift = 0;
  for (;;) {
    const b = buf[i++];
    if (b === undefined) {
      throw new Error('truncated EthAccount varint');
    }
    len |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      break;
    }
    shift += 7;
  }
  return buf.slice(i, i + len);
};
/* eslint-enable no-bitwise -- end of varint reader */

/**
 * Decode Injective's `/injective.types.v1beta1.EthAccount` value bytes to the
 * account_number and sequence a SignDoc needs. EthAccount is
 * `{ BaseAccount base_account = 1; bytes code_hash = 2; }`, so we lift field 1
 * and decode the standard BaseAccount inside it.
 */
export function decodeEthAccount(ethAccountValue: Uint8Array): {
  accountNumber: bigint;
  sequence: bigint;
} {
  const base = BaseAccount.decode(readLengthDelimitedField1(ethAccountValue));
  return { accountNumber: base.accountNumber, sequence: base.sequence };
}
