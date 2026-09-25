import { describe, expect, it } from 'vitest';
import { TxBody, TxRaw, AuthInfo } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { MsgGrantAllowance } from 'cosmjs-types/cosmos/feegrant/v1beta1/tx';
import { AllowedMsgAllowance } from 'cosmjs-types/cosmos/feegrant/v1beta1/feegrant';
import { deriveInjectiveWallet } from '@repo/wallet/networks/injective/derive';
import { Granter, GrantError, type GranterDeps } from './granter';

const MNEMONIC =
  'notice oak worry limit wrap speak medal online prefer cluster roof addict wrist behave treat actual wasp year salad speed social layer crew genius';
const GRANTEE = 'inj1clwfv4vqh5ef25qg2e9cd5lwm2k287g8n557zd';
const LCD = 'https://lcd.test';

interface FakeLcd {
  allowance?: object;
  broadcastCode?: number;
  /** polls answered 404 before the tx shows up; Infinity = never included */
  pendingPolls?: number;
  includedCode?: number;
}

/** Minimal Injective LCD. Records every broadcast tx for inspection. */
const makeLcd = (granter: string, lcd: FakeLcd) => {
  const broadcasts: Uint8Array[] = [];
  let polls = 0;
  const route = (input: string | URL, init?: RequestInit): Response => {
    const url = String(input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.includes('/cosmos/feegrant/v1beta1/allowances/')) {
      return json({
        allowances: lcd.allowance ? [{ granter, grantee: GRANTEE, allowance: lcd.allowance }] : [],
      });
    }
    if (url.includes('/cosmos/auth/v1beta1/accounts/')) {
      return json({ account: { base_account: { account_number: '7', sequence: '3' } } });
    }
    if (url.endsWith('/cosmos/tx/v1beta1/txs') && init?.method === 'POST') {
      const { tx_bytes } = JSON.parse(init.body as string) as { tx_bytes: string };
      broadcasts.push(Uint8Array.from(Buffer.from(tx_bytes, 'base64')));
      return json({
        tx_response: { code: lcd.broadcastCode ?? 0, txhash: 'HASH', raw_log: 'rejected' },
      });
    }
    if (url.includes('/cosmos/tx/v1beta1/txs/HASH')) {
      polls += 1;
      if (polls <= (lcd.pendingPolls ?? 0)) {
        return json({}, 404);
      }
      return json({ tx_response: { code: lcd.includedCode ?? 0, height: '100', raw_log: '' } });
    }
    return json({ error: `unexpected ${url}` }, 500);
  };
  const fetchFn = ((input: string | URL, init?: RequestInit) =>
    Promise.resolve(route(input, init))) as typeof fetch;
  return { fetchFn, broadcasts };
};

const setup = async (lcd: FakeLcd) => {
  const wallet = await deriveInjectiveWallet(MNEMONIC, 0);
  const { fetchFn, broadcasts } = makeLcd(wallet.address, lcd);
  let clock = Date.parse('2026-09-24T00:00:00Z');
  const deps: GranterDeps = {
    fetchFn,
    now: () => new Date(clock),
    // advance the fake clock instead of waiting
    sleep: ms => {
      clock += ms;
      return Promise.resolve();
    },
  };
  const granter = new Granter(
    wallet,
    {
      lcdUrl: LCD,
      chainId: 'injective-1',
      spendLimit: 1_000_000_000_000_000n,
      grantTtlMs: 24 * 3_600_000,
      shieldFee: 200_000_000_000_000n,
    },
    deps,
  );
  return { granter, broadcasts, wallet };
};

const msgTypes = (raw: Uint8Array) =>
  TxBody.decode(TxRaw.decode(raw).bodyBytes).messages.map(m => m.typeUrl);

const usableAllowance = {
  '@type': '/cosmos.feegrant.v1beta1.AllowedMsgAllowance',
  allowance: {
    '@type': '/cosmos.feegrant.v1beta1.BasicAllowance',
    spend_limit: [{ denom: 'inj', amount: '800000000000000' }],
    expiration: '2026-09-24T20:00:00Z',
  },
  allowed_messages: ['/ibc.applications.transfer.v1.MsgTransfer'],
};

describe('Granter.ensureGrant', () => {
  it('grants a fresh address and waits for inclusion', async () => {
    const { granter, broadcasts, wallet } = await setup({ pendingPolls: 2 });
    const out = await granter.ensureGrant(GRANTEE);
    expect(out).toMatchObject({ status: 'granted', txhash: 'HASH', height: '100' });

    expect(broadcasts).toHaveLength(1);
    expect(msgTypes(broadcasts[0]!)).toEqual(['/cosmos.feegrant.v1beta1.MsgGrantAllowance']);
    const grant = MsgGrantAllowance.decode(
      TxBody.decode(TxRaw.decode(broadcasts[0]!).bodyBytes).messages[0]!.value,
    );
    expect(grant).toMatchObject({ granter: wallet.address, grantee: GRANTEE });
    // the granter pays its own fee: no fee granter on the grant tx itself
    expect(AuthInfo.decode(TxRaw.decode(broadcasts[0]!).authInfoBytes).fee?.granter).toBe('');
  });

  it('reuses a usable allowance without signing anything', async () => {
    const { granter, broadcasts } = await setup({ allowance: usableAllowance });
    const out = await granter.ensureGrant(GRANTEE);
    expect(out.status).toBe('exists');
    expect(broadcasts).toHaveLength(0);
  });

  it('grants shield AND send', async () => {
    const { granter, broadcasts } = await setup({ pendingPolls: 0 });
    await granter.ensureGrant(GRANTEE);
    const grant = MsgGrantAllowance.decode(
      TxBody.decode(TxRaw.decode(broadcasts[0]!).bodyBytes).messages[0]!.value,
    );
    const allowed = AllowedMsgAllowance.decode(grant.allowance!.value);
    expect(allowed.allowedMessages).toEqual([
      '/ibc.applications.transfer.v1.MsgTransfer',
      '/cosmos.bank.v1beta1.MsgSend',
    ]);
  });

  it('upgrades a transfer-only grant when a send is asked for', async () => {
    const { granter, broadcasts } = await setup({ allowance: usableAllowance });
    expect((await granter.ensureGrant(GRANTEE, '/cosmos.bank.v1beta1.MsgSend')).status).toBe(
      'granted',
    );
    expect(msgTypes(broadcasts[0]!)).toEqual([
      '/cosmos.feegrant.v1beta1.MsgRevokeAllowance',
      '/cosmos.feegrant.v1beta1.MsgGrantAllowance',
    ]);
  });

  it('revokes and re-grants an exhausted allowance in one tx', async () => {
    const exhausted = {
      ...usableAllowance,
      allowance: { ...usableAllowance.allowance, spend_limit: [{ denom: 'inj', amount: '10' }] },
    };
    const { granter, broadcasts } = await setup({ allowance: exhausted });
    expect((await granter.ensureGrant(GRANTEE)).status).toBe('granted');
    expect(msgTypes(broadcasts[0]!)).toEqual([
      '/cosmos.feegrant.v1beta1.MsgRevokeAllowance',
      '/cosmos.feegrant.v1beta1.MsgGrantAllowance',
    ]);
  });

  it('fails without retry when the chain rejects the broadcast', async () => {
    const { granter } = await setup({ broadcastCode: 5 });
    const err = await granter.ensureGrant(GRANTEE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrantError);
    expect((err as GrantError).retryable).toBe(false);
  });

  it('reports a retryable error when inclusion outlasts the wait', async () => {
    const { granter } = await setup({ pendingPolls: Infinity });
    const err = await granter.ensureGrant(GRANTEE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrantError);
    expect((err as GrantError).retryable).toBe(true);
  });

  it('serializes concurrent grants (one hot key, one sequence)', async () => {
    const { granter, broadcasts } = await setup({});
    const order: string[] = [];
    await Promise.all([
      granter.ensureGrant(GRANTEE).then(() => order.push('a')),
      granter.ensureGrant(GRANTEE).then(() => order.push('b')),
    ]);
    expect(order).toEqual(['a', 'b']);
    expect(broadcasts).toHaveLength(2);
  });
});
