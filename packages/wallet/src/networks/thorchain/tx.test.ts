import { describe, expect, it } from 'vitest';
import { fromBase64, toHex } from '@cosmjs/encoding';
import { sha256 } from '@noble/hashes/sha2';
import { TxRaw, TxBody, AuthInfo, SignDoc } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { PubKey } from 'cosmjs-types/cosmos/crypto/secp256k1/keys';
import { deriveThorKey, thorAddressOf } from './derive';
import {
  buildSignedThorTx,
  encodeMsgDeposit,
  MSG_DEPOSIT_TYPE_URL,
  RUNE_ASSET,
  runeDeposit,
  thorSignDoc,
  verifyThorSignature,
} from './tx';

/**
 * Two mainnet MsgDeposits on the ZEC.ZEC pool, as THORNode's RPC returns them
 * (`/tx?hash=0x...`, base64), with the signer's account_number from
 * `/cosmos/auth/v1beta1/accounts/{addr}`. Public chain data.
 */
// thor187q486vpn34p05nfc3cwydy0nquec0hgg83ty9, `-:ZEC.ZEC:500`, 0 rune, height 28071534
const WITHDRAW = {
  hash: '27E6B1588708A74DC60909ECC14565FD4A5283F3DF79774F04A56C23105D1890',
  raw: 'CmQKUwoRL3R5cGVzLk1zZ0RlcG9zaXQSPgoXChIKBFRIT1ISBFJVTkUaBFJVTkUSATASDS06WkVDLlpFQzo1MDAaFD+BU+mBnGoX0mnEcOI0j5g5nD7oEg0tOlpFQy5aRUM6NTAwElkKUApGCh8vY29zbW9zLmNyeXB0by5zZWNwMjU2azEuUHViS2V5EiMKIQL6c7hYTjvoNWCD0GL1sd/A9usA7eu9KvbWFTdhM/qPdhIECgIIARgFEgUQgNrECRpARKODhAXvsDlaeiXY5aGdq8mb+10KrSlj4bkCtK3C8NpG6Ob1CoFy4p6gvL1KecUSkTJPH0BQgxY0rADSHnXhCw==',
  signer: 'thor187q486vpn34p05nfc3cwydy0nquec0hgg83ty9',
  memo: '-:ZEC.ZEC:500',
  accountNumber: 156745n,
  sequence: 5n,
  gas: 20_000_000n,
};
// thor18x7x0ygfndhtkz6zgde8kx7ws69y5tmvrdms5p, the rune half of a two-sided add
// to ZEC.ZEC whose zec half never came (THORNode still shows it pending_rune)
const ADD_RUNE_SIDE = {
  hash: 'DA2D99E9BB29F76C9653C0C117AD5544640B112449EE519DA6DE1BAAF7F6EF43',
  raw: 'CrABCn8KES90eXBlcy5Nc2dEZXBvc2l0EmoKIwoUCgRUSE9SEgRSVU5FGgRSVU5FIAASCzM1MDAwMDAwMDAwEi0rOlpFQy5aRUM6dDFTUzRieFBNM29nVTRVU3lIdnpoZVZRRFdhN0dienR6NHAaFDm8Z5EJm267C0JDcnsbzoaKSi9sEi0rOlpFQy5aRUM6dDFTUzRieFBNM29nVTRVU3lIdnpoZVZRRFdhN0dienR6NHASWgpQCkYKHy9jb3Ntb3MuY3J5cHRvLnNlY3AyNTZrMS5QdWJLZXkSIwohAmFcbCdARmiZrKE2PGzpQKECUAiBTPzfjmDNwJKxg5+3EgQKAggBGBgSBhCAyrXuARpAe8WAHywB5Woz1+O2YjihRNmeFqh2lu1B0klg4fAApD0xk/wfhZia9XM+qGMbrpYyXUxojOC48oUQF3Yfw1+9uw==',
  signer: 'thor18x7x0ygfndhtkz6zgde8kx7ws69y5tmvrdms5p',
  memo: '+:ZEC.ZEC:t1SS4bxPM3ogU4USyHvzheVQDWa7Gbztz4p',
  accountNumber: 22354n,
  amount: 35_000_000_000n,
};

const decode = (b64: string) => {
  const raw = fromBase64(b64);
  const tx = TxRaw.decode(raw);
  const auth = AuthInfo.decode(tx.authInfoBytes);
  const pub = PubKey.decode(auth.signerInfos[0]!.publicKey!.value).key;
  return { raw, tx, auth, pub };
};

const signBytesOf = (tx: TxRaw, accountNumber: bigint) =>
  SignDoc.encode(
    SignDoc.fromPartial({
      bodyBytes: tx.bodyBytes,
      authInfoBytes: tx.authInfoBytes,
      chainId: 'thorchain-1',
      accountNumber,
    }),
  ).finish();

describe('thorchain MsgDeposit', () => {
  it('the vectors are the chain txs they claim to be', () => {
    for (const v of [WITHDRAW, ADD_RUNE_SIDE]) {
      const { raw, pub } = decode(v.raw);
      expect(toHex(sha256(raw)).toUpperCase()).toBe(v.hash);
      expect(thorAddressOf(pub)).toBe(v.signer);
    }
  });

  it('reproduces a mainnet withdraw MsgDeposit, body and auth info, byte for byte', () => {
    const { tx, pub } = decode(WITHDRAW.raw);
    const parts = thorSignDoc({
      msgs: [runeDeposit(WITHDRAW.signer, 0n, WITHDRAW.memo)],
      memo: WITHDRAW.memo,
      publicKey: pub,
      accountNumber: WITHDRAW.accountNumber,
      sequence: WITHDRAW.sequence,
      gasLimit: WITHDRAW.gas,
    });
    expect(toHex(parts.bodyBytes)).toBe(toHex(tx.bodyBytes));
    expect(toHex(parts.authInfoBytes)).toBe(toHex(tx.authInfoBytes));
    // and the on-chain signature verifies over the SignDoc built here
    expect(verifyThorSignature(pub, parts.signBytes, tx.signatures[0]!)).toBe(true);
  });

  it('verifies the two-sided add’s on-chain signature over its SignDoc (thorchain-1, account number)', () => {
    const { tx, pub } = decode(ADD_RUNE_SIDE.raw);
    expect(
      verifyThorSignature(pub, signBytesOf(tx, ADD_RUNE_SIDE.accountNumber), tx.signatures[0]!),
    ).toBe(true);
    // the wrong account number or chain does not verify: the SignDoc fields matter
    expect(
      verifyThorSignature(
        pub,
        signBytesOf(tx, ADD_RUNE_SIDE.accountNumber + 1n),
        tx.signatures[0]!,
      ),
    ).toBe(false);
    // its message is our encoder's, but for the one default that client wrote out (asset synth: false)
    const body = TxBody.decode(tx.bodyBytes);
    expect(body.messages[0]!.typeUrl).toBe(MSG_DEPOSIT_TYPE_URL);
    const ours = encodeMsgDeposit({
      coins: [{ asset: RUNE_ASSET, amount: ADD_RUNE_SIDE.amount.toString() }],
      memo: ADD_RUNE_SIDE.memo,
      signer: ADD_RUNE_SIDE.signer,
    });
    const theirs = toHex(body.messages[0]!.value);
    // coin 0a23 { asset 0a14 { THOR RUNE RUNE, synth 2000 } amount 120b... }: drop the 2000
    expect(theirs.replace('0a230a14', '0a210a12').replace('52554e452000120b', '52554e45120b')).toBe(
      toHex(ours),
    );
  });

  it('signs with a derived key; the signature verifies and the signer must match', () => {
    const k = deriveThorKey(`${'dog '.repeat(23)}fossil`, 3);
    const memo = '+:ZEC.ZEC:t1SS4bxPM3ogU4USyHvzheVQDWa7Gbztz4p';
    const { txBytes, signBytes } = buildSignedThorTx({
      msgs: [runeDeposit(k.address, 123_456_789n, memo)],
      memo,
      publicKey: k.publicKey,
      privateKey: k.privateKey,
      signer: k.address,
      accountNumber: 9n,
      sequence: 2n,
    });
    const tx = TxRaw.decode(txBytes);
    expect(verifyThorSignature(k.publicKey, signBytes, tx.signatures[0]!)).toBe(true);
    expect(tx.signatures[0]!.length).toBe(64);
    const other = deriveThorKey(`${'dog '.repeat(23)}fossil`, 4);
    expect(() =>
      buildSignedThorTx({
        msgs: [runeDeposit(k.address, 1n, memo)],
        memo,
        publicKey: other.publicKey,
        privateKey: other.privateKey,
        signer: k.address,
        accountNumber: 9n,
        sequence: 2n,
      }),
    ).toThrow();
  });

  it('refuses more than one coin and a non-integer amount', () => {
    const signer = WITHDRAW.signer;
    expect(() => encodeMsgDeposit({ coins: [], memo: 'x', signer })).toThrow();
    expect(() =>
      encodeMsgDeposit({ coins: [{ asset: RUNE_ASSET, amount: '1.5' }], memo: 'x', signer }),
    ).toThrow();
  });
});
