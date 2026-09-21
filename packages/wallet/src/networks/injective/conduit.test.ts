import { describe, expect, it, vi } from 'vitest';
import { TxRaw, TxBody } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { MsgTransfer } from 'cosmjs-types/ibc/applications/transfer/v1/tx';
import { MsgSend } from 'cosmjs-types/cosmos/bank/v1beta1/tx';
import { shieldInToPenumbra, withdrawToExchange } from './conduit';

const MNEMONIC =
  'notice oak worry limit wrap speak medal online prefer cluster roof addict wrist behave treat actual wasp year salad speed social layer crew genius';

const jsonRes = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

/** a fetch that answers the account query then captures the broadcast body. */
function mockNode(captured: { tx?: Uint8Array }) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/accounts/')) {
      return jsonRes({ account: { base_account: { account_number: '5', sequence: '3' } } });
    }
    // broadcast
    const body = JSON.parse(init!.body as string) as { tx_bytes: string };
    captured.tx = Uint8Array.from(atob(body.tx_bytes), c => c.charCodeAt(0));
    return jsonRes({ tx_response: { txhash: 'HASH', code: 0, raw_log: '' } });
  });
}

describe('injective conduit', () => {
  const fee = { amount: [{ denom: 'inj', amount: '160000000000000' }], gas: '250000' };

  it('shield-in builds a signed IBC MsgTransfer to the Penumbra receiver and broadcasts', async () => {
    const captured: { tx?: Uint8Array } = {};
    const res = await shieldInToPenumbra({
      mnemonic: MNEMONIC,
      restUrl: 'https://lcd.example',
      fee,
      sourceChannel: 'channel-13',
      penumbraReceiver: 'penumbra1abc',
      token: { denom: 'erc20:0xa00C', amount: '5000000' },
      timeoutTimestamp: 1000000000000000000n,
      fetchFn: mockNode(captured) as never,
    });
    expect(res.txhash).toBe('HASH');
    expect(res.code).toBe(0);

    // the broadcast tx really carries our MsgTransfer with the right fields
    const body = TxBody.decode(TxRaw.decode(captured.tx!).bodyBytes);
    expect(body.messages[0]!.typeUrl).toBe('/ibc.applications.transfer.v1.MsgTransfer');
    const mt = MsgTransfer.decode(body.messages[0]!.value);
    expect(mt.sourceChannel).toBe('channel-13');
    expect(mt.receiver).toBe('penumbra1abc');
    expect(mt.token.amount).toBe('5000000');
  });

  it('withdraw builds a signed bank MsgSend to the exchange address', async () => {
    const captured: { tx?: Uint8Array } = {};
    const res = await withdrawToExchange({
      mnemonic: MNEMONIC,
      restUrl: 'https://lcd.example',
      fee,
      toAddress: 'inj1exchange',
      amount: { denom: 'erc20:0xa00C', amount: '2500000' },
      fetchFn: mockNode(captured) as never,
    });
    expect(res.code).toBe(0);

    const body = TxBody.decode(TxRaw.decode(captured.tx!).bodyBytes);
    expect(body.messages[0]!.typeUrl).toBe('/cosmos.bank.v1beta1.MsgSend');
    const ms = MsgSend.decode(body.messages[0]!.value);
    expect(ms.toAddress).toBe('inj1exchange');
    expect(ms.amount[0]!.amount).toBe('2500000');
  });
});
