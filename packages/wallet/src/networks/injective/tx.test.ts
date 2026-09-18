import { describe, expect, it } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { TxRaw, TxBody, AuthInfo, SignDoc } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { BaseAccount } from 'cosmjs-types/cosmos/auth/v1beta1/auth';
import { MsgSend } from 'cosmjs-types/cosmos/bank/v1beta1/tx';
import { deriveInjectiveWallet } from './derive';
import { buildSignedInjectiveTx, decodeEthAccount } from './tx';

const KEPLR_MNEMONIC =
  'notice oak worry limit wrap speak medal online prefer cluster roof addict wrist behave treat actual wasp year salad speed social layer crew genius';

describe('injective tx assembly', () => {
  it('produces a TxRaw whose eth_secp256k1 signature verifies over its own SignDoc', async () => {
    const w = await deriveInjectiveWallet(KEPLR_MNEMONIC, 0);

    const msg = {
      typeUrl: '/cosmos.bank.v1beta1.MsgSend',
      value: MsgSend.encode(
        MsgSend.fromPartial({
          fromAddress: w.address,
          toAddress: w.address,
          amount: [{ denom: 'inj', amount: '1000000000000000000' }],
        }),
      ).finish(),
    };

    const raw = buildSignedInjectiveTx({
      msgs: [msg],
      fee: { amount: [{ denom: 'inj', amount: '160000000000000' }], gas: '200000' },
      pubKey: w.publicKey,
      privKey: w.privateKey,
      accountNumber: 42n,
      sequence: 7,
      chainId: 'injective-1',
    });

    // Reconstruct the exact SignDoc bytes from the TxRaw and verify the sig -
    // this proves body/authInfo/signature are mutually consistent (the tx would
    // fail signature verification on-chain otherwise).
    const txRaw = TxRaw.decode(raw);
    expect(txRaw.signatures).toHaveLength(1);
    expect(txRaw.signatures[0]).toHaveLength(64);

    const signDocBytes = SignDoc.encode(
      SignDoc.fromPartial({
        bodyBytes: txRaw.bodyBytes,
        authInfoBytes: txRaw.authInfoBytes,
        chainId: 'injective-1',
        accountNumber: 42n,
      }),
    ).finish();

    const ok = secp256k1.verify(txRaw.signatures[0]!, keccak_256(signDocBytes), w.publicKey);
    expect(ok).toBe(true);

    // and the wrong (sha256) digest must fail, confirming Ethermint signing
    const { sha256 } = await import('@noble/hashes/sha2');
    expect(secp256k1.verify(txRaw.signatures[0]!, sha256(signDocBytes), w.publicKey)).toBe(false);

    // body round-trips to our message
    const body = TxBody.decode(txRaw.bodyBytes);
    expect(body.messages[0]!.typeUrl).toBe('/cosmos.bank.v1beta1.MsgSend');
    // authInfo announces the ethsecp256k1 pubkey type
    const authInfo = AuthInfo.decode(txRaw.authInfoBytes);
    expect(authInfo.signerInfos[0]!.publicKey!.typeUrl).toBe(
      '/injective.crypto.v1beta1.ethsecp256k1.PubKey',
    );
  });

  it('decodes an Injective EthAccount to account_number + sequence', () => {
    // build a BaseAccount, wrap it as EthAccount { base_account = 1 } and decode
    const baseBytes = BaseAccount.encode(
      BaseAccount.fromPartial({ address: 'inj1x', accountNumber: 12345n, sequence: 99n }),
    ).finish();
    // EthAccount field 1 (tag 0x0a) + length + base_account bytes
    const ethAccount = new Uint8Array(2 + baseBytes.length);
    ethAccount[0] = 0x0a;
    ethAccount[1] = baseBytes.length; // < 128
    ethAccount.set(baseBytes, 2);

    const { accountNumber, sequence } = decodeEthAccount(ethAccount);
    expect(accountNumber).toBe(12345n);
    expect(sequence).toBe(99n);
  });
});
