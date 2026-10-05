/**
 * THORChain's native MsgDeposit, encoded by hand, and the SIGN_MODE_DIRECT tx
 * around it.
 *
 * THORNode proto (v3.20, proto/thorchain/v1):
 *   types.MsgDeposit { repeated common.Coin coins = 1; string memo = 2; bytes signer = 3; bytes salt = 4; }
 *   common.Coin      { common.Asset asset = 1; string amount = 2; int64 decimals = 3; }
 *   common.Asset     { string chain = 1; string symbol = 2; string ticker = 3; bool synth = 4; bool trade = 5; bool secured = 6; }
 * `asset` and `amount` are non-nullable gogoproto fields, so they are always
 * written (an amount of "0" included), as THORNode itself marshals them.
 * MsgDeposit.ValidateBasic wants exactly one coin, native to THORChain; a
 * withdraw carries 0 rune (test/regression suites: `coins: [{amount: "0", asset: rune}]`).
 *
 * Signing is plain cosmos secp256k1: sha256 over the SignDoc bytes, low-S,
 * 64-byte r||s, the pubkey announced as /cosmos.crypto.secp256k1.PubKey. No
 * fee coin: THORChain takes its native fee (0.02 rune) from the balance.
 * tx.test.ts reproduces a mainnet MsgDeposit byte for byte and verifies its
 * on-chain signature with this SignDoc.
 */

import { BinaryWriter } from 'cosmjs-types/binary';
import { TxBody, TxRaw, SignDoc } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { PubKey } from 'cosmjs-types/cosmos/crypto/secp256k1/keys';
import { SignMode } from 'cosmjs-types/cosmos/tx/signing/v1beta1/signing';
import { makeAuthInfoBytes } from '@cosmjs/proto-signing';
import { sha256 } from '@noble/hashes/sha2';
import { secp256k1 } from '@noble/curves/secp256k1';
import { THOR_CHAIN_ID, thorAccountBytes, thorAddressOf } from './derive';

export const MSG_DEPOSIT_TYPE_URL = '/types.MsgDeposit';
export const SECP256K1_PUBKEY_TYPE_URL = '/cosmos.crypto.secp256k1.PubKey';

/** a MsgDeposit's gas limit: no fee rides on it, it only has to clear what THORNode meters (~18.5M seen) */
export const DEPOSIT_GAS_LIMIT = 500_000_000n;

export interface ThorAsset {
  chain: string;
  symbol: string;
  ticker: string;
  synth?: boolean;
  trade?: boolean;
  secured?: boolean;
}

export const RUNE_ASSET: ThorAsset = { chain: 'THOR', symbol: 'RUNE', ticker: 'RUNE' };

export interface ThorCoin {
  asset: ThorAsset;
  /** base units, 1e8, as a decimal string */
  amount: string;
  decimals?: number;
}

export interface MsgDepositFields {
  coins: ThorCoin[];
  memo: string;
  /** the signer's thor1 address */
  signer: string;
}

const writeAsset = (w: BinaryWriter, a: ThorAsset) => {
  if (a.chain) {
    w.uint32(10).string(a.chain);
  }
  if (a.symbol) {
    w.uint32(18).string(a.symbol);
  }
  if (a.ticker) {
    w.uint32(26).string(a.ticker);
  }
  if (a.synth) {
    w.uint32(32).bool(true);
  }
  if (a.trade) {
    w.uint32(40).bool(true);
  }
  if (a.secured) {
    w.uint32(48).bool(true);
  }
};

const writeCoin = (w: BinaryWriter, c: ThorCoin) => {
  if (!/^\d+$/.test(c.amount)) {
    throw new Error(`coin amount ${c.amount} is not a base-unit integer`);
  }
  w.uint32(10).fork();
  writeAsset(w, c.asset);
  w.ldelim();
  w.uint32(18).string(c.amount);
  if (c.decimals) {
    w.uint32(24).int64(c.decimals);
  }
};

/** the MsgDeposit value bytes */
export const encodeMsgDeposit = (m: MsgDepositFields): Uint8Array => {
  if (m.coins.length !== 1) {
    throw new Error('a MsgDeposit carries exactly one coin');
  }
  const w = BinaryWriter.create();
  for (const c of m.coins) {
    w.uint32(10).fork();
    writeCoin(w, c);
    w.ldelim();
  }
  if (m.memo) {
    w.uint32(18).string(m.memo);
  }
  w.uint32(26).bytes(thorAccountBytes(m.signer));
  return w.finish();
};

/** a rune MsgDeposit with `memo`: an add carries its rune, a withdraw carries 0 */
export const runeDeposit = (signer: string, runeBase: bigint, memo: string) => ({
  typeUrl: MSG_DEPOSIT_TYPE_URL,
  value: encodeMsgDeposit({
    coins: [{ asset: RUNE_ASSET, amount: runeBase.toString() }],
    memo,
    signer,
  }),
});

export const secp256k1PubKeyAny = (publicKey: Uint8Array) => ({
  typeUrl: SECP256K1_PUBKEY_TYPE_URL,
  value: PubKey.encode({ key: publicKey }).finish(),
});

export interface ThorTxParts {
  msgs: { typeUrl: string; value: Uint8Array }[];
  /** the body memo; THORChain clients set the deposit memo here too */
  memo: string;
  publicKey: Uint8Array;
  accountNumber: bigint;
  sequence: bigint;
  chainId?: string;
  gasLimit?: bigint;
}

/** body, auth info and the SignDoc bytes a key signs */
export const thorSignDoc = (p: ThorTxParts) => {
  const bodyBytes = TxBody.encode(TxBody.fromPartial({ messages: p.msgs, memo: p.memo })).finish();
  const authInfoBytes = makeAuthInfoBytes(
    [{ pubkey: secp256k1PubKeyAny(p.publicKey), sequence: p.sequence }],
    [],
    Number(p.gasLimit ?? DEPOSIT_GAS_LIMIT),
    undefined,
    undefined,
    SignMode.SIGN_MODE_DIRECT,
  );
  const signBytes = SignDoc.encode(
    SignDoc.fromPartial({
      bodyBytes,
      authInfoBytes,
      chainId: p.chainId ?? THOR_CHAIN_ID,
      accountNumber: p.accountNumber,
    }),
  ).finish();
  return { bodyBytes, authInfoBytes, signBytes };
};

/** a cosmos secp256k1 signature: sha256 digest, low-S, r||s */
export const signThorBytes = (privateKey: Uint8Array, signBytes: Uint8Array): Uint8Array =>
  secp256k1.sign(sha256(signBytes), privateKey, { lowS: true }).toBytes('compact');

export const verifyThorSignature = (
  publicKey: Uint8Array,
  signBytes: Uint8Array,
  signature: Uint8Array,
): boolean => {
  try {
    return secp256k1.verify(signature, sha256(signBytes), publicKey);
  } catch {
    return false;
  }
};

/**
 * A signed TxRaw, ready to simulate or broadcast. Refuses when a message's
 * signer is not the key that signs, so a stale address never signs for another.
 */
export const buildSignedThorTx = (
  p: ThorTxParts & { privateKey: Uint8Array; signer: string },
): { txBytes: Uint8Array; signBytes: Uint8Array } => {
  if (thorAddressOf(p.publicKey) !== p.signer) {
    throw new Error('this key does not sign for that thorchain address');
  }
  const { bodyBytes, authInfoBytes, signBytes } = thorSignDoc(p);
  const signature = signThorBytes(p.privateKey, signBytes);
  return {
    txBytes: TxRaw.encode(
      TxRaw.fromPartial({ bodyBytes, authInfoBytes, signatures: [signature] }),
    ).finish(),
    signBytes,
  };
};
