import { describe, expect, it, vi } from 'vitest';
import { HYPERLIQUID_API } from './api';
import {
  buildHyperliquidAction,
  microToUsdc,
  postHyperliquidAction,
  queryHyperliquidBalances,
  signHyperliquidAction,
  usdcToMicro,
} from './client';

const TO = '0x5E9ee1089755c3435139848e47e6635505d5a13A';
const KEY = new Uint8Array(32).fill(7);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('usdc amounts', () => {
  it('round-trips the form that is signed', () => {
    for (const [text, micro] of [
      ['1', 1_000_000n],
      ['0.000001', 1n],
      ['12.5', 12_500_000n],
      ['1471.758984', 1_471_758_984n],
    ] as const) {
      expect(usdcToMicro(text)).toBe(micro);
      expect(microToUsdc(micro)).toBe(text);
    }
  });

  it('drops digits past the sixth, so a balance is never overstated', () => {
    expect(usdcToMicro('1471.75898499')).toBe(1_471_758_984n);
    expect(usdcToMicro('0.0')).toBe(0n);
  });
});

describe('queryHyperliquidBalances', () => {
  it('reads both accounts from the info endpoint, by lowercase address', async () => {
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as { type: string; user: string };
      expect(body.user).toBe(TO.toLowerCase());
      return body.type === 'clearinghouseState'
        ? json({ withdrawable: '2.319897', marginSummary: { accountValue: '9.0' } })
        : json({
            balances: [
              { coin: 'PURR', total: '5.0', hold: '0.0' },
              { coin: 'USDC', total: '10.5', hold: '0.25' },
            ],
          });
    });
    expect(await queryHyperliquidBalances(TO, fetchFn as never)).toEqual({
      perp: 2_319_897n,
      spot: 10_250_000n,
    });
    expect(fetchFn.mock.calls.map(c => c[0])).toEqual([
      `${HYPERLIQUID_API}/info`,
      `${HYPERLIQUID_API}/info`,
    ]);
  });

  it('reads an account that holds nothing as zero', async () => {
    const fetchFn = async (_url: unknown, init?: RequestInit) =>
      (JSON.parse(init!.body as string) as { type: string }).type === 'clearinghouseState'
        ? json({ withdrawable: '0.0' })
        : json({ balances: [] });
    expect(await queryHyperliquidBalances(TO, fetchFn as never)).toEqual({ perp: 0n, spot: 0n });
  });

  it('throws rather than show a zero it did not read', async () => {
    await expect(queryHyperliquidBalances(TO, (async () => json({})) as never)).rejects.toThrow();
    await expect(
      queryHyperliquidBalances(TO, (async () => json({}, 500)) as never),
    ).rejects.toThrow('500');
  });
});

describe('buildHyperliquidAction', () => {
  it('names mainnet, the lowercase destination and the amount as shown', () => {
    expect(buildHyperliquidAction('withdraw3', TO, 12_500_000n, 1700000000000)).toEqual({
      type: 'withdraw3',
      hyperliquidChain: 'Mainnet',
      signatureChainId: '0xa4b1',
      destination: TO.toLowerCase(),
      amount: '12.5',
      time: 1700000000000,
    });
  });

  it('adds the usdc token to a spot send only', () => {
    expect(buildHyperliquidAction('spotSend', TO, 1n, 1)).toMatchObject({
      token: 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054',
    });
    expect(buildHyperliquidAction('usdSend', TO, 1n, 1)).not.toHaveProperty('token');
  });

  it('refuses a bad address or an empty amount', () => {
    expect(() => buildHyperliquidAction('usdSend', '0x1234', 1n, 1)).toThrow();
    expect(() => buildHyperliquidAction('usdSend', TO, 0n, 1)).toThrow();
  });
});

describe('postHyperliquidAction', () => {
  const signed = signHyperliquidAction(KEY, buildHyperliquidAction('usdSend', TO, 1_000_000n, 42));

  it('posts the action, its time as the nonce, and the signature', async () => {
    const fetchFn = vi.fn(async () => json({ status: 'ok', response: { type: 'default' } }));
    expect(await postHyperliquidAction(signed, fetchFn as never)).toEqual({ outcome: 'ok' });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${HYPERLIQUID_API}/exchange`);
    expect(JSON.parse(init.body as string)).toEqual({
      action: signed.action,
      nonce: 42,
      signature: signed.signature,
    });
  });

  it('reports a refusal with the reason hyperliquid gave', async () => {
    const err = (async () => json({ status: 'err', response: 'Insufficient balance' })) as never;
    expect(await postHyperliquidAction(signed, err)).toEqual({
      outcome: 'refused',
      reason: 'Insufficient balance',
    });
    const bad = (async () => new Response('Failed to deserialize', { status: 422 })) as never;
    expect(await postHyperliquidAction(signed, bad)).toEqual({
      outcome: 'refused',
      reason: 'Failed to deserialize',
    });
  });

  it('calls it unclear when no answer says either way', async () => {
    const down = (async () => {
      throw new Error('network down');
    }) as never;
    expect(await postHyperliquidAction(signed, down)).toEqual({
      outcome: 'unclear',
      reason: 'network down',
    });
    const gateway = (async () => new Response('bad gateway', { status: 502 })) as never;
    expect((await postHyperliquidAction(signed, gateway)).outcome).toBe('unclear');
    const garbled = (async () => new Response('<html>', { status: 200 })) as never;
    expect((await postHyperliquidAction(signed, garbled)).outcome).toBe('unclear');
  });
});
