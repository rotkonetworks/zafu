import { describe, expect, it, vi } from 'vitest';
import { MsgSend } from 'cosmjs-types/cosmos/bank/v1beta1/tx';
import { MsgTransfer } from 'cosmjs-types/ibc/applications/transfer/v1/tx';
import {
  queryInjectiveAccount,
  queryInjectiveBalances,
  queryInjectiveTx,
  broadcastInjectiveTx,
  buildMsgSend,
  buildMsgTransfer,
} from './client';

const USDC_DENOM = 'erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a';

const jsonRes = (body: unknown, ok = true, status = 200): Promise<Response> =>
  Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as Response);

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
    const fetchFn = vi.fn(() => jsonRes(realShape));
    const acct = await queryInjectiveAccount('https://lcd.example', 'inj1x', fetchFn as never);
    expect(acct.accountNumber).toBe(22594n);
    expect(acct.sequence).toBe(0);
    expect(fetchFn).toHaveBeenCalledWith('https://lcd.example/cosmos/auth/v1beta1/accounts/inj1x');
  });

  it('throws on an unfunded account', async () => {
    const fetchFn = vi.fn(() => jsonRes({ account: {} }));
    await expect(
      queryInjectiveAccount('https://lcd.example', 'inj1x', fetchFn as never),
    ).rejects.toThrow(/unfunded|not found/);
  });

  it('reads USDC.inj + INJ balances from the all-balances endpoint', async () => {
    const body = {
      balances: [
        { denom: 'inj', amount: '5000000000000000' },
        { denom: USDC_DENOM, amount: '12500000' },
        { denom: 'peggy0xother', amount: '999' },
      ],
      pagination: { next_key: null, total: '3' },
    };
    const fetchFn = vi.fn(() => jsonRes(body));
    const bal = await queryInjectiveBalances(
      'https://lcd.example',
      'inj1x',
      USDC_DENOM,
      fetchFn as never,
    );
    expect(bal.usdc).toBe(12500000n);
    expect(bal.inj).toBe(5000000000000000n);
    expect(fetchFn).toHaveBeenCalledWith('https://lcd.example/cosmos/bank/v1beta1/balances/inj1x');
  });

  it('matches the USDC denom case-insensitively and defaults missing coins to 0', async () => {
    const fetchFn = vi.fn(() =>
      jsonRes({ balances: [{ denom: USDC_DENOM.toLowerCase(), amount: '7' }] }),
    );
    const bal = await queryInjectiveBalances(
      'https://lcd.example',
      'inj1x',
      USDC_DENOM,
      fetchFn as never,
    );
    expect(bal.usdc).toBe(7n);
    expect(bal.inj).toBe(0n);
  });

  it('returns zero balances for a never-funded (empty) account', async () => {
    const fetchFn = vi.fn(() => jsonRes({ balances: [] }));
    const bal = await queryInjectiveBalances(
      'https://lcd.example',
      'inj1x',
      USDC_DENOM,
      fetchFn as never,
    );
    expect(bal).toEqual({ usdc: 0n, inj: 0n });
  });

  it('reports a tx as pending (not found) on a 404', async () => {
    const fetchFn = vi.fn(() => jsonRes({}, false, 404));
    const st = await queryInjectiveTx('https://lcd.example', 'HASH', fetchFn as never);
    expect(st.found).toBe(false);
  });

  it('reports a tx as pending while it has no block height yet', async () => {
    const fetchFn = vi.fn(() => jsonRes({ tx_response: { code: 0, height: '0' } }));
    const st = await queryInjectiveTx('https://lcd.example', 'HASH', fetchFn as never);
    expect(st.found).toBe(false);
  });

  it('reports an included tx with its code and height', async () => {
    const fetchFn = vi.fn(() =>
      jsonRes({ tx_response: { code: 0, height: '12345', raw_log: '' } }),
    );
    const st = await queryInjectiveTx('https://lcd.example', 'HASH', fetchFn as never);
    expect(st).toEqual({ found: true, code: 0, height: '12345', rawLog: '' });
  });

  it('surfaces an included-but-failed tx (non-zero code)', async () => {
    const fetchFn = vi.fn(() =>
      jsonRes({ tx_response: { code: 11, height: '99', raw_log: 'out of gas' } }),
    );
    const st = await queryInjectiveTx('https://lcd.example', 'HASH', fetchFn as never);
    expect(st.found).toBe(true);
    expect(st.code).toBe(11);
    expect(st.rawLog).toContain('out of gas');
  });

  it('broadcasts a TxRaw as base64 and reports the result', async () => {
    const fetchFn = vi.fn(() =>
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
    const fetchFn = vi.fn(() =>
      jsonRes({ tx_response: { txhash: 'DEAD', code: 5, raw_log: 'insufficient funds' } }),
    );
    const res = await broadcastInjectiveTx(
      'https://lcd.example',
      new Uint8Array([0]),
      fetchFn as never,
    );
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
