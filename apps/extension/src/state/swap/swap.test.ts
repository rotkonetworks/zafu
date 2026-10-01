import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const asked: string[] = [];
const allow = new Set<string>();
vi.mock('../../net/egress-opt-in', () => ({
  requestEgressOptIn: (id: string) => {
    asked.push(id);
    return Promise.resolve(allow.has(id));
  },
}));

const near = vi.hoisted(() => ({
  getSupportedTokens: vi.fn(),
  requestQuote: vi.fn(),
  checkSwapStatus: vi.fn(),
}));
vi.mock('../near-swap', async orig => ({ ...(await orig<object>()), ...near }));

import { fromUnits, rank, rescale, toUnits, type Quote, type QuoteRequest } from './provider';
import { candidates, ROUTES } from './routes';
import { checkQuote, thorProvider, type InboundAddress, type ThorQuote } from './thor';
import { nearProvider } from './near';
import { quoteRoutes, routeTokens } from '.';

const NOW = 1_790_000_000;
const T = 't1PTs8DQifJxg6HmUq7AgYYFNkbyQa1zjgf';
const ZEC_VAULT = 't1ZecVaultxxxxxxxxxxxxxxxxxxxxxxxx';
const BTC_VAULT = 'bc1qbtcvaultxxxxxxxxxxxxxxxxxxxxxxxxxx';
const inbound = (over: Partial<InboundAddress> = {}): InboundAddress[] => [
  {
    chain: 'ZEC',
    address: ZEC_VAULT,
    halted: false,
    global_trading_paused: false,
    chain_trading_paused: false,
  },
  {
    chain: 'BTC',
    address: BTC_VAULT,
    halted: false,
    global_trading_paused: false,
    chain_trading_paused: false,
    dust_threshold: '1000',
    ...over,
  },
];
const thorQuote = (over: Partial<ThorQuote> = {}): ThorQuote => ({
  inbound_address: BTC_VAULT,
  expiry: NOW + 600,
  memo: '=:ZEC.ZEC:t1PTs8DQifJxg6HmUq7AgYYFNkbyQa1zjgf:0/1/0',
  expected_amount_out: '412000000',
  recommended_min_amount_in: '20000',
  total_swap_seconds: 720,
  fees: { asset: 'ZEC.ZEC', total: '1200000', total_bps: 30 },
  ...over,
});

const BTC = { symbol: 'BTC', chain: 'btc', decimals: 8 };
const req = (over: Partial<QuoteRequest> = {}): QuoteRequest => ({
  direction: 'into_zec',
  token: BTC,
  amountIn: '0.01',
  zcashAddress: 'u1shieldedexample',
  zcashTransparent: 't1PTs8DQifJxg6HmUq7AgYYFNkbyQa1zjgf',
  otherAddress: 'bc1qrefundexample',
  ...over,
});
const q = (route: Quote['route'], out: bigint, notYet?: string): Quote => ({
  route,
  amountOut: out,
  amountOutText: '',
  amountInText: '',
  depositAddress: '',
  recipient: '',
  notYet,
  raw: undefined,
});

const nearTokens = [
  { assetId: 'nep141:btc.omft.near', decimals: 8, blockchain: 'btc', symbol: 'BTC', price: 1 },
  { assetId: 'nep141:zec.omft.near', decimals: 8, blockchain: 'zec', symbol: 'ZEC', price: 1 },
];
const nearQuote = {
  timestamp: '',
  quoteRequest: {},
  quote: {
    depositAddress: 'bc1qneardeposit',
    amountIn: '1000000',
    amountInFormatted: '0.01',
    amountInUsd: '0',
    amountOut: '415000000',
    amountOutFormatted: '4.15',
    amountOutUsd: '0',
    timeEstimate: 120,
    deadline: new Date(NOW * 1000 + 600_000).toISOString(),
  },
};

/** answers thornode paths, records each url asked */
const thornode = (quote: ThorQuote, inb = inbound()) => {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      urls.push(url);
      const body = url.includes('/quote/swap') ? quote : inb;
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }),
  );
  return urls;
};

beforeEach(() => {
  asked.length = 0;
  allow.clear();
  vi.useFakeTimers({ now: NOW * 1000, toFake: ['Date'] });
  near.getSupportedTokens.mockResolvedValue(nearTokens);
  near.requestQuote.mockResolvedValue(nearQuote);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('units', () => {
  it('converts exactly, without floats', () => {
    expect(toUnits('0.1', 8)).toBe(10_000_000n);
    expect(toUnits('1.123456789', 8)).toBe(112_345_678n);
    expect(toUnits('3', 18)).toBe(3n * 10n ** 18n);
    expect(fromUnits(412_000_000n, 8)).toBe('4.12');
    expect(fromUnits(5n, 8)).toBe('0.00000005');
    expect(rescale(412_000_000n, 8, 18)).toBe(4_120_000_000_000_000_000n);
    expect(rescale(412_000_000n, 8, 6)).toBe(4_120_000n);
  });
});

describe('rank', () => {
  it('puts the most out first, and a route zafu cannot send yet last', () => {
    const ranked = rank([q('near', 100n), q('thor', 200n, 'not available yet'), q('thor', 150n)]);
    expect(ranked.map(r => [r.route, r.amountOut])).toEqual([
      ['thor', 150n],
      ['near', 100n],
      ['thor', 200n],
    ]);
  });
});

describe('routes', () => {
  it('offers every route that can carry a pair, or only the pinned one', () => {
    expect(candidates({ direction: 'into_zec', symbol: 'btc', chain: 'btc' })).toEqual([
      'near',
      'thor',
    ]);
    expect(candidates({ direction: 'from_zec', symbol: 'sol', chain: 'sol' })).toEqual(['near']);
    expect(candidates({ direction: 'into_zec', symbol: 'usdc', chain: 'eth' })).toEqual(['near']);
    expect(candidates({ direction: 'from_zec', symbol: 'usdc', chain: 'eth' })).toEqual([
      'near',
      'thor',
    ]);
    expect(candidates({ direction: 'from_zec', symbol: 'btc' }, 'thor')).toEqual(['thor']);
  });

  it('never puts penumbra on a zec pair', () => {
    expect(ROUTES.penumbra.refuses({ direction: 'into_zec', symbol: 'um' })).toMatch(
      /doesn't trade zec/,
    );
    expect(candidates({ direction: 'from_zec', symbol: 'um' })).not.toContain('penumbra');
  });
});

describe('thorchain', () => {
  it('quotes btc into zec: the vault, the memo, the zec to the transparent address', async () => {
    const urls = thornode(thorQuote());
    const quote = await thorProvider.quote(req());
    expect(quote).toMatchObject({
      route: 'thor',
      amountOut: 412_000_000n,
      amountOutText: '4.12',
      amountInText: '0.01',
      feeText: 'fee 0.3%',
      timeText: '~12 min',
      expiresAt: (NOW + 600) * 1000,
      depositAddress: BTC_VAULT,
      memo: '=:ZEC.ZEC:t1PTs8DQifJxg6HmUq7AgYYFNkbyQa1zjgf:0/1/0',
      recipient: 't1PTs8DQifJxg6HmUq7AgYYFNkbyQa1zjgf',
    });
    expect(quote.notYet).toBeUndefined();
    const params = new URL(urls.find(u => u.includes('/quote/swap'))!).searchParams;
    expect(Object.fromEntries(params)).toMatchObject({
      from_asset: 'BTC.BTC',
      to_asset: 'ZEC.ZEC',
      amount: '1000000',
      destination: 't1PTs8DQifJxg6HmUq7AgYYFNkbyQa1zjgf',
      refund_address: 'bc1qrefundexample',
    });
    expect(asked).toContain('thorchain');
  });

  it('quotes zec out for comparison, marked not yet: no OP_RETURN builder', async () => {
    thornode(
      thorQuote({
        inbound_address: ZEC_VAULT,
        memo: '=:BTC.BTC:bc1qdestexample:0/1/0',
        expected_amount_out: '24000',
        fees: { asset: 'BTC.BTC', total: '1' },
      }),
    );
    const quote = await thorProvider.quote(
      req({ direction: 'from_zec', amountIn: '1', otherAddress: 'bc1qdestexample' }),
    );
    expect(quote).toMatchObject({
      amountOut: 24_000n,
      depositAddress: ZEC_VAULT,
      notYet: 'not available yet',
    });
  });

  it('pays only transparent addresses, so a wallet without one gets a calm line', async () => {
    thornode(thorQuote());
    await expect(thorProvider.quote(req({ zcashTransparent: undefined }))).rejects.toThrow(
      /transparent/,
    );
  });

  it('refuses unsafe quotes', () => {
    const ok = () => checkQuote(thorQuote(), inbound(), 'BTC', 1_000_000n, true, T, NOW);
    expect(ok).not.toThrow();
    expect(() =>
      checkQuote(thorQuote(), inbound().slice(1), 'BTC', 1_000_000n, true, T, NOW),
    ).toThrow(/zec isn't open/);
    expect(() =>
      checkQuote(thorQuote(), inbound({ halted: true }), 'BTC', 1_000_000n, true, T, NOW),
    ).toThrow(/paused btc/);
    expect(() =>
      checkQuote(
        thorQuote({ inbound_address: 'bc1qold' }),
        inbound(),
        'BTC',
        1_000_000n,
        true,
        T,
        NOW,
      ),
    ).toThrow(/moved its vault/);
    expect(() =>
      checkQuote(
        thorQuote({ memo: `=:ZEC.ZEC:${'t'.repeat(80)}` }),
        inbound(),
        'BTC',
        1_000_000n,
        true,
        T,
        NOW,
      ),
    ).toThrow(/memo/);
    expect(() =>
      checkQuote(thorQuote({ expiry: NOW }), inbound(), 'BTC', 1_000_000n, true, T, NOW),
    ).toThrow(/expired/);
    expect(() => checkQuote(thorQuote(), inbound(), 'BTC', 20_000n, true, T, NOW)).toThrow(/below/);
    // a node answering with a memo that pays someone else is never shown
    expect(() =>
      checkQuote(thorQuote(), inbound(), 'BTC', 1_000_000n, true, 't1SomeoneElse', NOW),
    ).toThrow(/another address/);
  });

  it('lists its tokens without a request', async () => {
    vi.stubGlobal('fetch', vi.fn());
    expect(await thorProvider.tokens()).toContainEqual(BTC);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('near intents', () => {
  it('sends 1click the same quote request as before', async () => {
    const quote = await nearProvider.quote(req());
    expect(near.requestQuote).toHaveBeenCalledWith({
      swapType: 'EXACT_INPUT',
      amount: '1000000',
      originAsset: 'nep141:btc.omft.near',
      destinationAsset: 'nep141:zec.omft.near',
      recipient: 'u1shieldedexample',
      refundTo: 'bc1qrefundexample',
    });
    expect(quote).toMatchObject({
      route: 'near',
      amountOut: 415_000_000n,
      amountOutText: '4.15',
      depositAddress: 'bc1qneardeposit',
      recipient: 'u1shieldedexample',
      timeText: '~2 min',
    });
    await nearProvider.quote(req({ direction: 'from_zec', otherAddress: 'bc1qdest' }));
    expect(near.requestQuote).toHaveBeenLastCalledWith(
      expect.objectContaining({
        originAsset: 'nep141:zec.omft.near',
        destinationAsset: 'nep141:btc.omft.near',
        recipient: 'bc1qdest',
        refundTo: 'u1shieldedexample',
      }),
    );
  });

  it('reads 1click status as a phase and a line', async () => {
    near.checkSwapStatus.mockResolvedValue({ status: 'PROCESSING' });
    expect(await nearProvider.status!(q('near', 0n))).toEqual({
      phase: 'processing',
      line: 'processing the swap',
    });
    near.checkSwapStatus.mockResolvedValue({ status: null });
    expect((await nearProvider.status!(q('near', 0n))).phase).toBe('waiting');
    near.checkSwapStatus.mockResolvedValue({ status: 'REFUNDED' });
    expect((await nearProvider.status!(q('near', 0n))).phase).toBe('failed');
  });
});

describe('best route', () => {
  it('asks each route one at a time, then ranks every quote', async () => {
    allow.add('near-swap').add('thorchain');
    thornode(thorQuote());
    const results = await quoteRoutes(['near', 'thor'], req());
    expect(asked.slice(0, 2)).toEqual(['near-swap', 'thorchain']);
    expect(results.map(r => r.route)).toEqual(['near', 'thor']);
  });

  it('leaves out a route the user declined, and keeps a failed route with its reason', async () => {
    allow.add('thorchain');
    thornode(thorQuote(), inbound().slice(1));
    const results = await quoteRoutes(['near', 'thor'], req());
    expect(near.requestQuote).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ route: 'thor', error: expect.any(Error) });
  });

  it('quotes only the pinned route', async () => {
    allow.add('near-swap').add('thorchain');
    vi.stubGlobal('fetch', vi.fn());
    const results = await quoteRoutes(['near'], req());
    expect(results.map(r => r.route)).toEqual(['near']);
    expect(asked).toEqual(['near-swap']);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('merges the pickers, one row per token and chain', async () => {
    const tokens = await routeTokens(['near', 'thor']);
    expect(tokens.filter(t => t.symbol === 'BTC' && t.chain === 'btc')).toHaveLength(1);
    expect(tokens.some(t => t.symbol === 'DOGE')).toBe(true);
  });
});
