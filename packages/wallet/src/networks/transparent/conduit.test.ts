import { describe, expect, it, vi } from 'vitest';
import { TxBody, TxRaw, AuthInfo } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { MsgTransfer } from 'cosmjs-types/ibc/applications/transfer/v1/tx';

// Wrap the coin-118 helpers so the ethermint conduit can be proven to never
// call them (a prefix-swapped coin-118 address is a wrong, fund-losing inj1).
vi.mock('../cosmos/signer', async importActual => {
  const actual = await importActual<typeof import('../cosmos/signer')>();
  return {
    ...actual,
    deriveCosmosWallet: vi.fn(actual.deriveCosmosWallet),
    deriveChainAddress: vi.fn(actual.deriveChainAddress),
    createSigningClient: vi.fn(actual.createSigningClient),
    signAndBroadcast: vi.fn(actual.signAndBroadcast),
  };
});

import * as cosmosSigner from '../cosmos/signer';
import { deriveInjectiveAddress } from '../injective/derive';
import { conduitFor, ethermintConduitForTest } from './conduit';

const MNEMONIC =
  'notice oak worry limit wrap speak medal online prefer cluster roof addict wrist behave treat actual wasp year salad speed social layer crew genius';

const jsonRes = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

/** answers the account query, returns the queued broadcast results in order */
function mockNode(results: { code: number; raw_log: string }[], captured: Uint8Array[] = []) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/accounts/')) {
      return jsonRes({ account: { base_account: { account_number: '5', sequence: '3' } } });
    }
    if (url.includes('/balances/')) {
      return jsonRes({ balances: [{ denom: 'inj', amount: '7' }] });
    }
    const body = JSON.parse(init!.body as string) as { tx_bytes: string };
    captured.push(Uint8Array.from(atob(body.tx_bytes), c => c.charCodeAt(0)));
    const r = results.shift() ?? { code: 0, raw_log: '' };
    return jsonRes({ tx_response: { txhash: 'HASH', ...r } });
  });
}

describe('transparent conduit', () => {
  it('derives injective addresses on the coin-60 path', async () => {
    const c = conduitFor('injective');
    expect(await c.deriveAddress(MNEMONIC, 3)).toBe(await deriveInjectiveAddress(MNEMONIC, 3));
  });

  it('derives noble addresses on the coin-118 path', async () => {
    const c = conduitFor('noble');
    const expected = (await cosmosSigner.deriveCosmosWallet(MNEMONIC, 2, 'noble')).address;
    expect(await c.deriveAddress(MNEMONIC, 2)).toBe(expected);
  });

  it('never touches the coin-118 helpers for injective', async () => {
    vi.mocked(cosmosSigner.deriveCosmosWallet).mockClear();
    vi.mocked(cosmosSigner.deriveChainAddress).mockClear();
    vi.mocked(cosmosSigner.createSigningClient).mockClear();
    vi.mocked(cosmosSigner.signAndBroadcast).mockClear();
    const fetchFn = mockNode([]) as unknown as typeof fetch;
    const c = ethermintConduitForTest('injective', { wait: async () => undefined, fetchFn });
    await c.deriveAddress(MNEMONIC, 0);
    await c.queryBalances('inj1x');
    await c.send({
      mnemonic: MNEMONIC,
      accountIndex: 0,
      to: 'inj1y',
      coin: { denom: 'inj', amount: '1' },
    });
    await c.ibcTransfer({
      mnemonic: MNEMONIC,
      accountIndex: 0,
      sourceChannel: 'channel-494',
      receiver: 'penumbra1abc',
      coin: { denom: 'inj', amount: '1' },
      timeoutTimestamp: 1n,
    });
    expect(cosmosSigner.deriveCosmosWallet).not.toHaveBeenCalled();
    expect(cosmosSigner.deriveChainAddress).not.toHaveBeenCalled();
    expect(cosmosSigner.createSigningClient).not.toHaveBeenCalled();
    expect(cosmosSigner.signAndBroadcast).not.toHaveBeenCalled();
  });

  it('prices injective gas in INJ at the fixed conduit limit', () => {
    const fee = conduitFor('injective').feeFor('send');
    expect(fee.denom).toBe('inj');
    expect(fee.gas).toBe('400000');
    expect(fee.amount).toBe(160000000n * 400000n);
  });

  it('reads injective balances from the LCD, keeping the bank denom spelling', async () => {
    const c = ethermintConduitForTest('injective', {
      wait: async () => undefined,
      fetchFn: mockNode([]) as unknown as typeof fetch,
    });
    expect(await c.queryBalances('inj1x')).toEqual([{ denom: 'inj', amount: 7n }]);
  });

  it('refuses to sign when the index no longer derives the expected address', async () => {
    const c = ethermintConduitForTest('injective', {
      wait: async () => undefined,
      fetchFn: mockNode([]) as unknown as typeof fetch,
    });
    await expect(
      c.send({
        mnemonic: MNEMONIC,
        accountIndex: 1,
        expectedAddress: await deriveInjectiveAddress(MNEMONIC, 0),
        to: 'inj1y',
        coin: { denom: 'inj', amount: '1' },
      }),
    ).rejects.toThrow(/mismatch/);
  });

  it('resends once when a fresh fee grant has not reached this node yet', async () => {
    const captured: Uint8Array[] = [];
    const wait = vi.fn(async () => undefined);
    const fetchFn = mockNode(
      [
        { code: 13, raw_log: 'fee-grant not found' },
        { code: 0, raw_log: '' },
      ],
      captured,
    ) as unknown as typeof fetch;
    const c = ethermintConduitForTest('injective', { wait, fetchFn });
    const res = await c.ibcTransfer({
      mnemonic: MNEMONIC,
      accountIndex: 0,
      sourceChannel: 'channel-494',
      receiver: 'penumbra1abc',
      coin: { denom: 'erc20:0xa00C', amount: '5000000' },
      timeoutTimestamp: 1n,
      feeGranter: 'inj1sponsor',
    });
    expect(res.code).toBe(0);
    expect(captured).toHaveLength(2);
    expect(wait).toHaveBeenCalledWith(3000);
    const raw = TxRaw.decode(captured[1]!);
    expect(AuthInfo.decode(raw.authInfoBytes).fee?.granter).toBe('inj1sponsor');
    const msg = MsgTransfer.decode(TxBody.decode(raw.bodyBytes).messages[0]!.value);
    expect(msg.sourceChannel).toBe('channel-494');
    expect(msg.receiver).toBe('penumbra1abc');
  });

  it('does not retry a rejection without a grant', async () => {
    const captured: Uint8Array[] = [];
    const c = ethermintConduitForTest('injective', {
      wait: async () => undefined,
      fetchFn: mockNode(
        [{ code: 13, raw_log: 'fee-grant not found' }],
        captured,
      ) as unknown as typeof fetch,
    });
    const res = await c.send({
      mnemonic: MNEMONIC,
      accountIndex: 0,
      to: 'inj1y',
      coin: { denom: 'inj', amount: '1' },
    });
    expect(res.code).toBe(13);
    expect(captured).toHaveLength(1);
  });

  it('offers a gas sponsor only where the chain config names one', () => {
    expect(conduitFor('injective').requestFeeGrant).toBeTypeOf('function');
    expect(conduitFor('noble').requestFeeGrant).toBeUndefined();
  });
});
