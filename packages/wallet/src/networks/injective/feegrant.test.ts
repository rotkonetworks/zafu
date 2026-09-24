import { describe, expect, it } from 'vitest';
import { MsgGrantAllowance, MsgRevokeAllowance } from 'cosmjs-types/cosmos/feegrant/v1beta1/tx';
import { AllowedMsgAllowance, BasicAllowance } from 'cosmjs-types/cosmos/feegrant/v1beta1/feegrant';
import { AuthInfo, TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { deriveInjectiveWallet } from './derive';
import { buildSignedInjectiveTx } from './tx';
import { buildMsgTransfer } from './client';
import {
  MSG_TRANSFER_TYPE_URL,
  allowanceCovers,
  buildMsgGrantAllowance,
  buildMsgRevokeAllowance,
  queryFeeAllowance,
  requestInjectiveFeeGrant,
} from './feegrant';

const MNEMONIC =
  'notice oak worry limit wrap speak medal online prefer cluster roof addict wrist behave treat actual wasp year salad speed social layer crew genius';
const GRANTER = 'inj1894x96sr2leg0y7rpkce9rqm3qujrhh3k78nq5';
const GRANTEE = 'inj1clwfv4vqh5ef25qg2e9cd5lwm2k287g8n557zd';

const jsonFetch = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('injective feegrant messages', () => {
  it('MsgGrantAllowance round-trips as AllowedMsgAllowance(BasicAllowance)', () => {
    const expiration = new Date('2026-09-25T00:00:00Z');
    const msg = buildMsgGrantAllowance({
      granter: GRANTER,
      grantee: GRANTEE,
      spendLimit: [{ denom: 'inj', amount: '1000000000000000' }],
      expiration,
      allowedMessages: [MSG_TRANSFER_TYPE_URL],
    });
    expect(msg.typeUrl).toBe('/cosmos.feegrant.v1beta1.MsgGrantAllowance');

    const grant = MsgGrantAllowance.decode(msg.value);
    expect(grant.granter).toBe(GRANTER);
    expect(grant.grantee).toBe(GRANTEE);
    expect(grant.allowance?.typeUrl).toBe('/cosmos.feegrant.v1beta1.AllowedMsgAllowance');

    const allowed = AllowedMsgAllowance.decode(grant.allowance!.value);
    expect(allowed.allowedMessages).toEqual([MSG_TRANSFER_TYPE_URL]);
    expect(allowed.allowance?.typeUrl).toBe('/cosmos.feegrant.v1beta1.BasicAllowance');

    const basic = BasicAllowance.decode(allowed.allowance!.value);
    expect(basic.spendLimit).toEqual([{ denom: 'inj', amount: '1000000000000000' }]);
    expect(basic.expiration?.seconds).toBe(BigInt(expiration.getTime() / 1000));
  });

  it('MsgRevokeAllowance names the pair', () => {
    const msg = buildMsgRevokeAllowance(GRANTER, GRANTEE);
    expect(msg.typeUrl).toBe('/cosmos.feegrant.v1beta1.MsgRevokeAllowance');
    expect(MsgRevokeAllowance.decode(msg.value)).toMatchObject({
      granter: GRANTER,
      grantee: GRANTEE,
    });
  });
});

describe('sponsored tx', () => {
  it('puts the fee granter into the signed AuthInfo', async () => {
    const w = await deriveInjectiveWallet(MNEMONIC, 0);
    const raw = buildSignedInjectiveTx({
      msgs: [
        buildMsgTransfer({
          sourceChannel: 'channel-494',
          sender: w.address,
          receiver: 'penumbra1test',
          token: { denom: 'inj', amount: '1' },
          timeoutTimestamp: 1n,
        }),
      ],
      fee: { amount: [{ denom: 'inj', amount: '200000000000000' }], gas: '400000' },
      pubKey: w.publicKey,
      privKey: w.privateKey,
      accountNumber: 1n,
      sequence: 0,
      chainId: 'injective-1',
      feeGranter: GRANTER,
    });
    const authInfo = AuthInfo.decode(TxRaw.decode(raw).authInfoBytes);
    expect(authInfo.fee?.granter).toBe(GRANTER);
    expect(authInfo.fee?.payer).toBe('');
  });

  it('leaves the granter empty when unsponsored', async () => {
    const w = await deriveInjectiveWallet(MNEMONIC, 0);
    const raw = buildSignedInjectiveTx({
      msgs: [],
      fee: { amount: [{ denom: 'inj', amount: '1' }], gas: '1' },
      pubKey: w.publicKey,
      privKey: w.privateKey,
      accountNumber: 1n,
      sequence: 0,
      chainId: 'injective-1',
    });
    expect(AuthInfo.decode(TxRaw.decode(raw).authInfoBytes).fee?.granter).toBe('');
  });
});

describe('queryFeeAllowance', () => {
  const lcdAllowance = {
    allowances: [
      {
        granter: 'inj1someoneelse',
        grantee: GRANTEE,
        allowance: { '@type': '/cosmos.feegrant.v1beta1.BasicAllowance', spend_limit: [] },
      },
      {
        granter: GRANTER,
        grantee: GRANTEE,
        allowance: {
          '@type': '/cosmos.feegrant.v1beta1.AllowedMsgAllowance',
          allowance: {
            '@type': '/cosmos.feegrant.v1beta1.BasicAllowance',
            spend_limit: [{ denom: 'inj', amount: '800000000000000' }],
            expiration: '2026-09-25T00:00:00Z',
          },
          allowed_messages: [MSG_TRANSFER_TYPE_URL],
        },
      },
    ],
  };

  it('parses the nested allowance issued by our granter', async () => {
    const info = await queryFeeAllowance('https://lcd', GRANTER, GRANTEE, jsonFetch(lcdAllowance));
    expect(info).toEqual({
      spendLimit: [{ denom: 'inj', amount: '800000000000000' }],
      expiration: new Date('2026-09-25T00:00:00Z'),
      allowedMessages: [MSG_TRANSFER_TYPE_URL],
    });
  });

  it('returns null when our granter has issued nothing', async () => {
    const info = await queryFeeAllowance(
      'https://lcd',
      GRANTER,
      GRANTEE,
      jsonFetch({ allowances: [], pagination: {} }),
    );
    expect(info).toBeNull();
  });
});

describe('allowanceCovers', () => {
  const fee = { denom: 'inj', amount: '200000000000000' };
  const now = new Date('2026-09-24T00:00:00Z');
  const base = {
    spendLimit: [{ denom: 'inj', amount: '1000000000000000' }],
    expiration: new Date('2026-09-25T00:00:00Z'),
    allowedMessages: [MSG_TRANSFER_TYPE_URL],
  };

  it('covers a fee within limit, type and time', () => {
    expect(allowanceCovers(base, fee, MSG_TRANSFER_TYPE_URL, now)).toBe(true);
  });
  it('rejects an exhausted limit', () => {
    expect(
      allowanceCovers(
        { ...base, spendLimit: [{ denom: 'inj', amount: '100' }] },
        fee,
        MSG_TRANSFER_TYPE_URL,
        now,
      ),
    ).toBe(false);
  });
  it('rejects an expired or nearly expired allowance', () => {
    expect(
      allowanceCovers(
        { ...base, expiration: new Date(now.getTime() + 30_000) },
        fee,
        MSG_TRANSFER_TYPE_URL,
        now,
      ),
    ).toBe(false);
  });
  it('rejects a message type outside the filter', () => {
    expect(allowanceCovers(base, fee, '/cosmos.bank.v1beta1.MsgSend', now)).toBe(false);
  });
});

describe('requestInjectiveFeeGrant', () => {
  it('returns the granter on success', async () => {
    const res = await requestInjectiveFeeGrant(
      'https://sponsor/',
      GRANTEE,
      jsonFetch({ granter: GRANTER, status: 'granted', txhash: 'AB', height: '1' }),
    );
    expect(res.granter).toBe(GRANTER);
  });
  it('surfaces the service error message', async () => {
    await expect(
      requestInjectiveFeeGrant(
        'https://sponsor',
        GRANTEE,
        jsonFetch({ error: 'daily budget reached' }, 429),
      ),
    ).rejects.toThrow('daily budget reached');
  });
});
