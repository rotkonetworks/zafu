import { describe, expect, it } from 'vitest';
import { toBase64 } from '@cosmjs/encoding';
import { AuthInfo, TxBody } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { MsgSend } from 'cosmjs-types/cosmos/bank/v1beta1/tx';
import { MsgExec } from 'cosmjs-types/cosmos/authz/v1beta1/tx';
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx';
import { readKeplrDirect } from './signer';

const send = MsgSend.fromPartial({
  fromAddress: 'noble1from',
  toAddress: 'noble1to',
  amount: [{ denom: 'uusdc', amount: '1500000' }],
});
const any = (typeUrl: string, value: Uint8Array) => ({ typeUrl, value });
const sendAny = any(MsgSend.typeUrl, MsgSend.encode(send).finish());

const wire = (messages: { typeUrl: string; value: Uint8Array }[]) => ({
  bodyBytesB64: toBase64(TxBody.encode(TxBody.fromPartial({ messages, memo: 'hi' })).finish()),
  authInfoBytesB64: toBase64(
    AuthInfo.encode(
      AuthInfo.fromPartial({
        signerInfos: [{ sequence: 7n }],
        fee: { amount: [{ denom: 'uusdc', amount: '2000' }], gasLimit: 200000n },
      }),
    ).finish(),
  ),
  chainId: 'noble-1',
  accountNumber: '42',
});

describe('readKeplrDirect', () => {
  it('reads the messages, fee and memo of the bytes that get signed', () => {
    const { doc, unread } = readKeplrDirect(wire([sendAny]));
    expect(unread).toEqual([]);
    expect(doc).toMatchObject({
      chain_id: 'noble-1',
      account_number: '42',
      sequence: '7',
      memo: 'hi',
      fee: { amount: [{ denom: 'uusdc', amount: '2000' }], gasLimit: '200000' },
      msgs: [
        {
          type: '/cosmos.bank.v1beta1.MsgSend',
          value: {
            fromAddress: 'noble1from',
            toAddress: 'noble1to',
            amount: [{ denom: 'uusdc', amount: '1500000' }],
          },
        },
      ],
    });
  });

  it('reads what an authz exec carries inside it', () => {
    const exec = MsgExec.encode(MsgExec.fromPartial({ grantee: 'noble1g', msgs: [sendAny] }));
    const { doc, unread } = readKeplrDirect(wire([any(MsgExec.typeUrl, exec.finish())]));
    expect(unread).toEqual([]);
    expect(doc.msgs[0]).toMatchObject({
      value: {
        grantee: 'noble1g',
        msgs: [{ type: MsgSend.typeUrl, value: { toAddress: 'noble1to' } }],
      },
    });
  });

  it('shows a contract call as its json', () => {
    const call = MsgExecuteContract.encode(
      MsgExecuteContract.fromPartial({
        sender: 'osmo1s',
        contract: 'osmo1c',
        msg: new TextEncoder().encode('{"swap":{"min":"1"}}'),
      }),
    ).finish();
    const { doc, unread } = readKeplrDirect(wire([any(MsgExecuteContract.typeUrl, call)]));
    expect(unread).toEqual([]);
    expect(doc.msgs[0]).toMatchObject({ value: { msg: { swap: { min: '1' } } } });
  });

  it('names every type it cannot read, including one nested in an exec', () => {
    const odd = any('/osmosis.poolmanager.v1beta1.MsgSwapExactAmountIn', new Uint8Array([1, 2]));
    const exec = MsgExec.encode(MsgExec.fromPartial({ grantee: 'noble1g', msgs: [odd] })).finish();
    const { unread } = readKeplrDirect(wire([sendAny, any(MsgExec.typeUrl, exec), odd]));
    expect(unread).toEqual([odd.typeUrl, odd.typeUrl]);
  });

  it('throws on bytes that are not a transaction body', () => {
    expect(() =>
      readKeplrDirect({ ...wire([]), bodyBytesB64: toBase64(new Uint8Array([0xff, 0xff])) }),
    ).toThrow();
  });
});
