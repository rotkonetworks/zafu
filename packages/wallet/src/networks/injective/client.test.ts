import { describe, expect, it, vi } from 'vitest';
import { MsgSend } from 'cosmjs-types/cosmos/bank/v1beta1/tx';
import { MsgTransfer } from 'cosmjs-types/ibc/applications/transfer/v1/tx';
import {
  queryInjectiveAccount,
  broadcastInjectiveTx,
  buildMsgSend,
  buildMsgTransfer,
} from './client';

const jsonRes = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as Response;

describe('injective client', () => {
  it('parses a real on-chain EthAccount shape', async () => {
    // captured verbatim from the live Injective LCD
    // (/cosmos/auth/v1beta1/accounts) - EthAccount wraps base_account
    const realShape = {
      account: {
        '@type': '/injective.types.v1beta1.EthAccount',
        base_account: {
          address: 'inj1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqe2hm49',
          pub_key: null,
          account_number: '22594',
          sequence: '0',
        },
        code_hash: '0x...',
      },
    };
    const fetchFn = vi.fn(async () => jsonRes(realShape));
    const acct = await queryInjectiveAccount('https://lcd.example', 'inj1x', fetchFn as never);
    expect(acct.accountNumber).toBe(22594n);
    expect(acct.sequence).toBe(0);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://lcd.example/cosmos/auth/v1beta1/accounts/inj1x',
    );
  });

  it('throws on an unfunded account', async () => {
    const fetchFn = vi.fn(async () => jsonRes({ account: {} }));
    await expect(
      queryInjectiveAccount('https://lcd.example', 'inj1x', fetchFn as never),
    ).rejects.toThrow(/unfunded|not found/);
  });

  it('broadcasts a TxRaw as base64 and reports the result', async () => {
    const fetchFn = vi.fn(async () =>
      jsonRes({ tx_response: { txhash: 'ABC123', code: 0, raw_log: '' } }),
    );
    const res = await broadcastInjectiveTx(
      'https://lcd.example',
      new Uint8Array([1, 2, 3, 4]),
      fetchFn as never,
    );
    expect(res).toEqual({ txhash: 'ABC123', code: 0, rawLog: '' });
    const call = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('https://lcd.example/cosmos/tx/v1beta1/txs');
    const body = JSON.parse(call[1].body as string) as {
      tx_bytes: string;
      mode: string;
    };
    expect(body.mode).toBe('BROADCAST_MODE_SYNC');
    expect(body.tx_bytes).toBe('AQIDBA=='); // base64 of [1,2,3,4]
  });

  it('surfaces a non-zero code (rejected tx) rather than throwing', async () => {
    const fetchFn = vi.fn(async () =>
      jsonRes({ tx_response: { txhash: 'DEAD', code: 5, raw_log: 'insufficient funds' } }),
    );
    const res = await broadcastInjectiveTx('https://lcd.example', new Uint8Array([0]), fetchFn as never);
    expect(res.code).toBe(5);
    expect(res.rawLog).toContain('insufficient funds');
  });

  it('builds a decodable MsgSend (withdraw leg)', () => {
    const m = buildMsgSend('inj1from', 'inj1to', [{ denom: 'peggy0x...', amount: '5000000' }]);
    expect(m.typeUrl).toBe('/cosmos.bank.v1beta1.MsgSend');
    const decoded = MsgSend.decode(m.value);
    expect(decoded.fromAddress).toBe('inj1from');
    expect(decoded.toAddress).toBe('inj1to');
    expect(decoded.amount[0]!.amount).toBe('5000000');
  });

  it('builds a decodable MsgTransfer (shield-in leg)', () => {
    const m = buildMsgTransfer({
      sourceChannel: 'channel-13',
      sender: 'inj1from',
      receiver: 'penumbra1recv',
      token: { denom: 'erc20:0xa00C...', amount: '5000000' },
      timeoutTimestamp: 1234567890000000000n,
      memo: '',
    });
    expect(m.typeUrl).toBe('/ibc.applications.transfer.v1.MsgTransfer');
    const decoded = MsgTransfer.decode(m.value);
    expect(decoded.sourcePort).toBe('transfer');
    expect(decoded.sourceChannel).toBe('channel-13');
    expect(decoded.receiver).toBe('penumbra1recv');
    expect(decoded.timeoutTimestamp).toBe(1234567890000000000n);
  });
});
