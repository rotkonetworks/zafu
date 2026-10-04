import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const asked: string[] = [];
const allow = new Set<string>();
vi.mock('../../net/egress-opt-in', () => ({
  requestEgressOptIn: (id: string) => {
    asked.push(id);
    return Promise.resolve(allow.has(id));
  },
}));

const fee = vi.hoisted(() => ({ recipient: '' }));
vi.mock('../../config/swap-fee', async orig => {
  const real = await orig<typeof import('../../config/swap-fee')>();
  return {
    ...real,
    zafuListBps: () => real.zafuListBps(fee.recipient),
    // near's recipient is switched per test; thorchain's affiliate is real
    zafuFeeBps: (route: string) =>
      route === 'near'
        ? real.zafuFeeBps(route, real.zafuListBps(fee.recipient))
        : real.zafuFeeBps(route),
  };
});

const near = vi.hoisted(() => ({
  getSupportedTokens: vi.fn(),
  requestQuote: vi.fn(),
  checkSwapStatus: vi.fn(),
}));
vi.mock('../near-swap', async orig => ({ ...(await orig<object>()), ...near }));

import {
  costOf,
  fromUnits,
  lead,
  pct,
  rank,
  rescale,
  toUnits,
  type Quote,
  type QuoteRequest,
} from './provider';
import { OFFERED, refundsToPayer, routeLabel, ROUTES, type RouteId, type SwapPair } from './routes';
import {
  BelowMinimum,
  memoLimit,
  checkQuote as nodeCheckQuote,
  nodeCost,
  nodeStatus,
  type InboundAddress,
  type NodeQuote,
} from './thornode';
import { thorProvider } from './thor';
import { depositFeeZat } from '../../workers/transparent-deposit';
import { mayaProvider } from './maya';
import { NeedsRefundAddress, nearCost, nearProvider } from './near';
import { PROVIDERS, routeTokens } from '.';
import { gates, plain } from './live';
import type { DestinationView } from '../../net/egress-policy';

/** every destination on: the routes a pair would ask */
const ALL_ON = ['near-swap', 'thorchain', 'mayachain'].map(id => ({
  id,
  on: true,
  why: 'you-allowed',
}));
const candidates = (pair: SwapPair, pinned?: RouteId) =>
  gates(pair, ALL_ON as DestinationView[], pinned)
    .filter(g => !g.line)
    .map(g => g.route);
const quoteEach = (ids: RouteId[], r: QuoteRequest) =>
  Promise.allSettled(ids.map(id => PROVIDERS[id]!.quote(r)));

const checkQuote = (
  ...a: Parameters<typeof nodeCheckQuote> extends [string, ...infer R] ? R : never
) => nodeCheckQuote('thorchain', ...a);
const thorStatus = (s: Parameters<typeof nodeStatus>[0]) => nodeStatus(s, 'thorchain');
const thorCost = (...a: Parameters<typeof nodeCost> extends [string, ...infer R] ? R : never) =>
  nodeCost('thorchain', ...a);

const NOW = 1_790_000_000;
const T = 't1PTs8DQifJxg6HmUq7AgYYFNkbyQa1zjgf';
// THORChain's live ZEC vault on 2026-10-04 is a ZIP 320 tex address
const ZEC_VAULT = 'tex1zclnr35llscdedzrwdmemm70es05ngg9m2d3lv';
const BTC_VAULT = 'bc1qbtcvaultxxxxxxxxxxxxxxxxxxxxxxxxxx';
// shapes recorded from gateway.liquify.com/chain/thorchain_api on 2026-10-02.
// mainnet lists no ZEC pool or vault yet, so the ZEC side mirrors BTC's.
const inbound = (over: Partial<InboundAddress> = {}): InboundAddress[] => [
  {
    chain: 'ZEC',
    address: ZEC_VAULT,
    halted: false,
    global_trading_paused: false,
    chain_trading_paused: false,
    dust_threshold: '10000',
    outbound_fee: '20000',
  },
  {
    chain: 'BTC',
    address: BTC_VAULT,
    halted: false,
    global_trading_paused: false,
    chain_trading_paused: false,
    dust_threshold: '1000',
    outbound_fee: '1042',
    ...over,
  },
];
/** BTC.BTC -> ETH.ETH as recorded, its output relabelled zec */
const thorQuote = (over: Partial<NodeQuote> = {}): NodeQuote => ({
  inbound_address: BTC_VAULT,
  expiry: NOW + 600,
  memo: `=:ZEC.ZEC:${T}/bc1qrefundexample:400000000/1/0`,
  expected_amount_out: '412000000',
  recommended_min_amount_in: '6123',
  dust_threshold: '1000',
  recommended_gas_rate: '3',
  gas_rate_units: 'satsperbyte',
  max_streaming_quantity: 1,
  streaming_swap_blocks: 1,
  total_swap_seconds: 720,
  fees: {
    asset: 'ZEC.ZEC',
    affiliate: '0',
    outbound: '9246',
    liquidity: '62579',
    total: '71825',
    slippage_bps: 1,
    total_bps: 1,
  },
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

/** answers thornode paths, records each url asked; `withFee` answers a quote carrying an affiliate */
const thornode = (quote: NodeQuote, inb = inbound(), withFee?: NodeQuote) => {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      urls.push(url);
      const body = !url.includes('/quote/swap')
        ? inb
        : withFee && url.includes('affiliate_bps')
          ? withFee
          : quote;
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }),
  );
  return urls;
};

beforeEach(() => {
  fee.recipient = '';
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

  it('round-trips 18-decimal values a float cannot hold', () => {
    for (const s of [
      '1.000000000000000001',
      '123456789012.345678901234567891',
      '0.000000000000000001',
    ]) {
      expect(fromUnits(toUnits(s, 18), 18, 18)).toBe(s);
    }
    expect(toUnits('1.000000000000000001', 18)).toBe(10n ** 18n + 1n);
    // past 2^53 in the whole part
    expect(toUnits('9007199254740993', 8)).toBe(900_719_925_474_099_300_000_000n);
    expect(toUnits('1e5', 8)).toBe(0n);
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
      timeText: '~12 min',
      expiresAt: (NOW + 600) * 1000,
      depositAddress: BTC_VAULT,
      memo: `=:ZEC.ZEC:${T}/bc1qrefundexample:400000000/1/0`,
      recipient: 't1PTs8DQifJxg6HmUq7AgYYFNkbyQa1zjgf',
    });
    expect(quote.notYet).toBeUndefined();
    const params = new URL(urls.find(u => u.includes('/quote/swap'))!).searchParams;
    expect(Object.fromEntries(params)).toMatchObject({
      from_asset: 'BTC.BTC',
      to_asset: 'ZEC.ZEC',
      amount: '1000000',
      destination: 't1PTs8DQifJxg6HmUq7AgYYFNkbyQa1zjgf',
    });
    // a btc deposit's memo must fit 80 bytes: no refund address, it refunds the sender
    expect(params.has('refund_address')).toBe(false);
    expect(asked).toContain('thorchain');
  });

  it('quotes zec out for comparison, marked not yet, where the wallet cannot sign an OP_RETURN', async () => {
    thornode(
      thorQuote({
        inbound_address: ZEC_VAULT,
        memo: '=:BTC.BTC:bc1qdestexample:400000000/1/0',
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
    const signs = await thorProvider.quote(
      req({
        direction: 'from_zec',
        amountIn: '1',
        otherAddress: 'bc1qdestexample',
        signsOpReturn: true,
      }),
    );
    expect(signs).toMatchObject({ notYet: undefined, watch: 'txid', memo: expect.any(String) });
  });

  it('out of zec, the fee out is the move and the deposit, and the time counts the move', async () => {
    const memo = '=:BTC.BTC:bc1qdestexample:400000000/1/0';
    thornode(
      thorQuote({
        inbound_address: ZEC_VAULT,
        memo,
        expected_amount_out: '24000',
        fees: { asset: 'BTC.BTC', total: '1' },
        total_swap_seconds: 600,
      }),
    );
    const quote = await thorProvider.quote(
      req({
        direction: 'from_zec',
        amountIn: '1',
        otherAddress: 'bc1qdestexample',
        signsOpReturn: true,
        sourceFeeZat: '15000',
      }),
    );
    expect(quote.sourceFeeZat).toBe(String(15_000n + depositFeeZat(memo.length)));
    expect(quote.sourceFeeNote).toBe('the move and the deposit');
    expect(quote.timeText).toBe('~13 min');
  });

  it('watches a zec deposit by its txid through every thornode stage', async () => {
    const done = { completed: true };
    const open = { completed: false };
    expect(thorStatus({})).toMatchObject({ phase: 'waiting' });
    expect(thorStatus({ stages: { inbound_observed: done } }).line).toBe(
      'deposit seen, confirming',
    );
    const final = { inbound_observed: done, inbound_finalised: done };
    expect(thorStatus({ stages: { ...final, swap_status: { pending: true } } })).toMatchObject({
      phase: 'processing',
    });
    expect(
      thorStatus({ stages: { ...final, swap_finalised: done, outbound_signed: open } }).line,
    ).toBe('sending to the recipient');
    expect(
      thorStatus({ stages: { ...final, swap_finalised: done, outbound_signed: done } }),
    ).toMatchObject({ phase: 'done' });
    expect(
      thorStatus({ stages: { ...final, swap_finalised: done }, out_txs: [{ memo: 'REFUND:AB' }] }),
    ).toMatchObject({ phase: 'refunded' });

    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        urls.push(url);
        return Promise.resolve(new Response('{"message":"not found"}', { status: 404 }));
      }),
    );
    expect(await thorProvider.status!(q('thor', 1n), 'abcd')).toMatchObject({ phase: 'waiting' });
    expect(urls[0]).toMatch(/\/thorchain\/tx\/status\/ABCD$/);
  });

  it('pays only transparent addresses, so a wallet without one gets a calm line', async () => {
    thornode(thorQuote());
    await expect(thorProvider.quote(req({ zcashTransparent: undefined }))).rejects.toThrow(
      /transparent/,
    );
  });

  it('refuses unsafe quotes', () => {
    const check = (quote = thorQuote(), inb = inbound(), dest = T) =>
      checkQuote(quote, inb, 'BTC', true, dest, NOW);
    expect(() => check()).not.toThrow();
    expect(() => check(thorQuote({ inbound_address: 'bc1qold' }))).toThrow(/moved its vault/);
    expect(() => check(thorQuote({ memo: `=:ZEC.ZEC:${'t'.repeat(80)}` }))).toThrow(/memo/);
    expect(() => check(thorQuote({ expiry: NOW }))).toThrow(/expired/);
    // a node answering with a memo that pays someone else is never shown
    expect(() => check(thorQuote(), inbound(), 't1SomeoneElse')).toThrow(/another address/);
  });

  it('out of zec, refuses a vault no t->t deposit could pay, before anything moves', () => {
    const out = (vault: string) => () =>
      checkQuote(
        thorQuote({ inbound_address: vault }),
        inbound().map(a => (a.chain === 'ZEC' ? { ...a, address: vault } : a)),
        'ZEC',
        true,
        T,
        NOW,
      );
    expect(out(ZEC_VAULT)).not.toThrow();
    expect(out(T)).not.toThrow();
    expect(out('u1shieldedvault')).toThrow(/can't pay/);
    expect(out('zs1saplingvault')).toThrow(/can't pay/);
  });

  it('says plainly when thorchain is not taking a chain, before reading the quote', async () => {
    const check = (inb: InboundAddress[]) => () =>
      checkQuote(thorQuote(), inb, 'BTC', true, T, NOW);
    expect(check(inbound().slice(1))).toThrow("thorchain isn't taking zec right now");
    expect(check(inbound({ halted: true }))).toThrow("thorchain isn't taking btc right now");
    expect(check(inbound({ chain_trading_paused: true }))).toThrow(/isn't taking btc/);
    expect(check(inbound({ global_trading_paused: true }))).toThrow(/isn't taking btc/);
    // the quote may answer anything for a halted chain; the halt is what is said
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          url.includes('/quote/swap')
            ? new Response('{"message":"trading is halted"}', { status: 400 })
            : new Response(JSON.stringify(inbound({ halted: true })), { status: 200 }),
        ),
      ),
    );
    await expect(thorProvider.quote(req())).rejects.toThrow("thorchain isn't taking btc right now");
  });

  it('holds back an amount below the recommended minimum, and names the minimum', async () => {
    thornode(thorQuote());
    const below = thorProvider.quote(req({ amountIn: '0.00005' }));
    await expect(below).rejects.toThrow('thorchain swaps 0.00006123 btc or more');
    await expect(below).rejects.toMatchObject({ min: 6123n });
    await expect(thorProvider.quote(req({ amountIn: '0.00006123' }))).resolves.toBeTruthy();
    // zec out: at or under the zec vault's dust nothing is observed
    thornode(
      thorQuote({
        inbound_address: ZEC_VAULT,
        memo: '=:BTC.BTC:bc1qdestexample:400000000/1/0',
        recommended_min_amount_in: '5000',
        dust_threshold: undefined,
      }),
    );
    const dust = thorProvider.quote(
      req({ direction: 'from_zec', amountIn: '0.0001', otherAddress: 'bc1qdestexample' }),
    );
    await expect(dust).rejects.toBeInstanceOf(BelowMinimum);
    await expect(dust).rejects.toThrow('thorchain swaps 0.00010001 zec or more');
  });

  it('costs a swap from the quote: the fee in, thorchain, and zafu as the quote took it', async () => {
    thornode(thorQuote());
    const quote = await thorProvider.quote(req());
    // 750 sat of 0.01 btc is 7.5 bps, rounded up and worth 750 sat at the pre-fee rate;
    // liquidity + outbound = 71825 of 4.12 zec is 1.74 bps, rounded, not thornode's truncated 1
    expect(quote.cost).toEqual({
      parts: [
        {
          label: 'network fee in',
          bps: 8,
          out: 309_053n,
          inText: '~0.0000075 btc',
        },
        { label: 'thorchain', bps: 2, out: 71_825n },
        { label: 'zafu fee', bps: 0, out: 0n, zafu: true },
      ],
      bps: 10,
      out: 380_878n,
    });
    expect(quote.gasLine).toBe('use a fast fee · 3 sat/byte');
    expect(quote.refundLine).toBeUndefined();
    // zafu's affiliate is asked for, and the memo the quote returns (the one signed) carries it
    // free in beta: the affiliate rides at 0 bps, so the volume is still zafu's
    const memo = `=:z:${T}:400000000/1/0:zafu:0`;
    const urls = thornode(thorQuote(), inbound(), thorQuote({ memo }));
    const paid = await thorProvider.quote(req());
    const asked = new URL(urls.find(u => u.includes('/quote/swap'))!).searchParams;
    expect([asked.get('affiliate'), asked.get('affiliate_bps')]).toEqual(['zafu', '0']);
    expect(paid.memo).toBe(memo);
    expect(paid.memo).toContain(':zafu:0');
    expect(paid.cost?.parts.at(-1)).toEqual({ label: 'zafu fee', bps: 0, out: 0n, zafu: true });

    // zec out: zafu's own zip-317 fee is priced on the deposit step, not here
    expect(thorCost(thorQuote(), false, 'zec', 100_000_000n, 8).parts.map(p => p.label)).toEqual([
      'thorchain',
      'zafu fee',
    ]);
    // a streamed swap can be refunded part way: the source chain's outbound fee comes off
    thornode(thorQuote({ max_streaming_quantity: 4 }));
    expect((await thorProvider.quote(req())).refundLine).toBe(
      'if refunded, thorchain keeps 0.00001042 btc to send it back',
    );
  });

  it('lists its tokens without a request', async () => {
    vi.stubGlobal('fetch', vi.fn());
    expect(await thorProvider.tokens()).toContainEqual(BTC);
    expect(fetch).not.toHaveBeenCalled();
  });
});

/** answers recorded from mayanode.mayachain.info (1.133.0) on 2026-10-02, trimmed to the fields read */
const MAYA_ZEC_VAULT = 't1VtnnhTYhmADh7L2uKU3Sev7GscBHT6HfE';
const MAYA_BTC_VAULT = 'bc1qs0dw6qhqqwxfu6ls9gwc4kc9was7z5zpjh9ngf';
const mayaInbound: InboundAddress[] = [
  {
    chain: 'BTC',
    address: MAYA_BTC_VAULT,
    halted: false,
    dust_threshold: '10000',
    outbound_fee: '150',
  },
  {
    chain: 'ZEC',
    address: MAYA_ZEC_VAULT,
    halted: false,
    dust_threshold: '10000',
    outbound_fee: '34614',
  },
];
const mayaIntoZec: NodeQuote = {
  inbound_address: MAYA_BTC_VAULT,
  expiry: NOW + 900,
  memo: `=:z:${T}:400000000/1/0`,
  expected_amount_out: '63176359',
  recommended_min_amount_in: '2188',
  dust_threshold: '10000',
  recommended_gas_rate: '3',
  gas_rate_units: 'satsperbyte',
  max_streaming_quantity: 1,
  total_swap_seconds: 600,
  fees: {
    asset: 'ZEC.ZEC',
    affiliate: '0',
    outbound: '34614',
    liquidity: '57195',
    total: '91809',
    slippage_bps: 9,
    total_bps: 14,
  },
};
const mayaFromZec: NodeQuote = {
  inbound_address: MAYA_ZEC_VAULT,
  expiry: NOW + 900,
  memo: '=:b:bc1qdest:400000000/1/0',
  expected_amount_out: '1574493',
  recommended_min_amount_in: '138456',
  dust_threshold: '10000',
  recommended_gas_rate: '90000',
  gas_rate_units: 'satsperbyte',
  max_streaming_quantity: 1,
  total_swap_seconds: 81,
  fees: {
    asset: 'BTC.BTC',
    affiliate: '0',
    outbound: '150',
    liquidity: '2250',
    total: '2400',
    slippage_bps: 14,
    total_bps: 15,
  },
};
const ok = { completed: true };
const mayaSwapped = {
  out_txs: [{ memo: 'OUT:C60B0DBABD9B6F813886E8EC7E45AB79CD98169AC03F4FF053E1FA62A4C00489' }],
  stages: {
    inbound_observed: ok,
    inbound_finalised: ok,
    swap_status: { pending: false },
    swap_finalised: ok,
    outbound_signed: ok,
  },
};

describe('maya', () => {
  it('is off: never a candidate, never listed, a link to it falls back to the router', () => {
    expect(ROUTES.maya.off).toBe("maya isn't offered right now");
    expect(OFFERED).not.toContain('maya');
    expect(candidates({ direction: 'into_zec', symbol: 'dash', chain: 'dash' })).toEqual(['near']);
    expect(candidates({ direction: 'into_zec', symbol: 'btc', chain: 'btc' }, 'maya')).toEqual([
      'near',
      'thor',
    ]);
  });

  it('asks nothing of mayanode on a quote round while off', async () => {
    allow.add('near-swap').add('thorchain').add('mayachain');
    const urls = thornode(thorQuote());
    await quoteEach(candidates({ direction: 'into_zec', symbol: 'btc', chain: 'btc' }), req());
    expect(asked).not.toContain('mayachain');
    expect(urls.some(u => u.includes('mayachain'))).toBe(false);
  });

  it('pays zec into the transparent address, refunded to whoever paid, no zafu fee', async () => {
    allow.add('mayachain');
    const urls = thornode(mayaIntoZec, mayaInbound);
    const quote = await mayaProvider.quote(req());
    expect(asked).toContain('mayachain');
    expect(urls.every(u => u.startsWith('https://mayanode.mayachain.info/mayachain/'))).toBe(true);
    const ask = new URL(urls.find(u => u.includes('/quote/swap'))!).searchParams;
    // no refund_address (it would push a btc memo past 80 bytes) and no affiliate
    expect(Object.fromEntries(ask)).toEqual({
      from_asset: 'BTC.BTC',
      to_asset: 'ZEC.ZEC',
      amount: '1000000',
      destination: T,
      streaming_interval: '1',
      liquidity_tolerance_bps: '300',
    });
    expect(quote).toMatchObject({
      route: 'maya',
      amountOut: 63_176_359n,
      amountOutText: '0.631763',
      timeText: '~10 min',
      depositAddress: MAYA_BTC_VAULT,
      memo: `=:z:${T}:400000000/1/0`,
      recipient: T,
      watch: undefined,
      notYet: undefined,
    });
    expect(quote.cost?.parts.map(p => [p.label, p.bps])).toEqual([
      ['network fee in', 8],
      ['maya', 15],
      ['zafu fee', 0],
    ]);
  });

  it('takes zec in as a memo deposit, for a signer that shows the memo', async () => {
    thornode(mayaFromZec, mayaInbound);
    const out = req({ direction: 'from_zec', otherAddress: 'bc1qdest' });
    expect(await mayaProvider.quote(out)).toMatchObject({
      amountOut: 1_574_493n,
      depositAddress: MAYA_ZEC_VAULT,
      memo: '=:b:bc1qdest:400000000/1/0',
      recipient: 'bc1qdest',
      notYet: 'not available yet',
      watch: 'txid',
    });
    expect((await mayaProvider.quote({ ...out, signsOpReturn: true })).notYet).toBeUndefined();
  });

  it('says calmly when maya has halted a chain, moved its vault, or the amount is too small', async () => {
    thornode(mayaIntoZec, [{ ...mayaInbound[0]!, halted: true }, mayaInbound[1]!]);
    await expect(mayaProvider.quote(req())).rejects.toThrow("maya isn't taking btc right now");
    thornode({ ...mayaIntoZec, inbound_address: 'bc1qold' }, mayaInbound);
    await expect(mayaProvider.quote(req())).rejects.toThrow('maya moved its vault');
    thornode(mayaIntoZec, mayaInbound);
    await expect(mayaProvider.quote(req({ amountIn: '0.00002' }))).rejects.toThrow(
      'maya swaps 0.00010001 btc or more',
    );
  });

  it('watches a deposit through the same stages as thornode', async () => {
    expect(nodeStatus(mayaSwapped, 'maya')).toEqual({ phase: 'done', line: 'swap complete' });
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        urls.push(url);
        return Promise.resolve(new Response('{"error":"fail to parse tx id"}', { status: 404 }));
      }),
    );
    expect(await mayaProvider.status!(q('maya', 1n), 'abcd')).toEqual({
      phase: 'waiting',
      line: 'waiting for maya to see the deposit',
    });
    expect(urls[0]).toBe('https://mayanode.mayachain.info/mayachain/tx/status/ABCD');
  });

  it('offers its pools, rune on thorchain among them', async () => {
    const tokens = await mayaProvider.tokens();
    expect(tokens).toContainEqual({ symbol: 'RUNE', chain: 'thor', decimals: 8 });
    expect(tokens).toContainEqual({ symbol: 'DASH', chain: 'dash', decimals: 8 });
    expect(ROUTES.maya.refuses({ direction: 'into_zec', symbol: 'doge' })).toMatch(
      /maya doesn't trade doge/,
    );
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
      slippageTolerance: 100,
      appFeeBps: 0,
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

  it("asks 1click's slippage of 1% outright, and shows its floor as at least", async () => {
    near.requestQuote.mockResolvedValue({
      ...nearQuote,
      quote: { ...nearQuote.quote, minAmountOut: '410850000' },
    });
    const quote = await nearProvider.quote(req());
    expect(near.requestQuote).toHaveBeenLastCalledWith(
      expect.objectContaining({ slippageTolerance: 100, swapType: 'EXACT_INPUT' }),
    );
    expect(quote.atLeastText).toBe('4.1085');
  });

  it('quotes by what arrives: exact output, and the deposit it asks for', async () => {
    // recorded 2026-10-04: 0.05 eth out of zec asks 0.10497108 zec in (the excess comes back)
    near.requestQuote.mockResolvedValue({
      ...nearQuote,
      quote: {
        ...nearQuote.quote,
        amountIn: '10497108',
        amountInFormatted: '0.10497108',
        minAmountIn: '10392136',
        amountOut: '50000000000000000',
        amountOutFormatted: '0.05',
        minAmountOut: '50000000000000000',
      },
    });
    const eth = {
      assetId: 'nep141:eth.omft.near',
      decimals: 18,
      blockchain: 'eth',
      symbol: 'ETH',
      price: 1,
    };
    near.getSupportedTokens.mockResolvedValue([...nearTokens, eth]);
    vi.setSystemTime(NOW * 1000 + 301_000); // past the cached token list
    const quote = await nearProvider.quote(
      req({
        direction: 'from_zec',
        token: { symbol: 'ETH', chain: 'eth', decimals: 18 },
        exactOut: '0.05',
        otherAddress: '0xdest',
      }),
    );
    expect(near.requestQuote).toHaveBeenLastCalledWith(
      expect.objectContaining({ swapType: 'EXACT_OUTPUT', amount: '50000000000000000' }),
    );
    expect(quote).toMatchObject({
      amountInText: '0.10497108',
      amountOutText: '0.05',
      atLeastText: '0.05',
    });
  });

  it('asks for an 18-decimal amount exactly', async () => {
    const eth = {
      assetId: 'nep141:eth.omft.near',
      decimals: 18,
      blockchain: 'eth',
      symbol: 'ETH',
      price: 1,
    };
    near.getSupportedTokens.mockResolvedValue([...nearTokens, eth]);
    vi.setSystemTime(NOW * 1000 + 301_000); // past the cached token list
    const token = { symbol: 'ETH', chain: 'eth', decimals: 18 };
    await nearProvider.quote(req({ token, amountIn: '1.000000000000000001' }));
    expect(near.requestQuote).toHaveBeenLastCalledWith(
      expect.objectContaining({ amount: '1000000000000000001' }),
    );
  });

  it("charges zafu's app fee at full price once a recipient is set", async () => {
    fee.recipient = 'zafu.near';
    const quote = await nearProvider.quote(req());
    expect(near.requestQuote).toHaveBeenLastCalledWith(expect.objectContaining({ appFeeBps: 0 }));
    expect(quote.cost?.parts.at(-1)).toMatchObject({ label: 'zafu fee', bps: 0, zafu: true });
  });

  it("splits a 1click quote's cost into near's and zafu's, from its own prices", () => {
    // $100 in, $99.40 out: 60 bps lost, 10 of them zafu's, on 4.15 zec arriving
    const cost = nearCost(415_000_000n, 100, 99.4, 10)!;
    expect(cost.bps).toBe(60);
    expect(cost.parts).toEqual([
      { label: 'near intents', bps: 50, out: 2_087_525n },
      { label: 'zafu fee', bps: 10, out: 417_505n, zafu: true },
    ]);
    // gross 4.17505 zec: the parts add up to what did not arrive
    expect(cost.out).toBe(2_505_030n);
    expect(nearCost(415_000_000n, 0, 99.4, 10)).toBeUndefined();
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
    expect((await nearProvider.status!(q('near', 0n))).phase).toBe('refunded');
    near.checkSwapStatus.mockResolvedValue({ status: 'FAILED' });
    expect((await nearProvider.status!(q('near', 0n))).phase).toBe('failed');
  });
});

describe("zafu's fee", () => {
  it('is free in beta on every route, from one flag, with the normal rate kept', async () => {
    const {
      zafuFeeBps,
      zafuListBps,
      ZAFU_BETA_FREE,
      ZAFU_PAID_FEE_BPS,
      ZAFU_FEE_OFF_PCT,
      NEAR_APP_FEE_BPS,
      THOR_AFFILIATE_BPS,
    } = await vi.importActual<typeof import('../../config/swap-fee')>('../../config/swap-fee');
    expect(ZAFU_BETA_FREE).toBe(true);
    expect(zafuListBps('')).toBe(0);
    expect(zafuListBps('zafu.near')).toBe(50);
    expect([zafuFeeBps('near'), zafuFeeBps('thor'), zafuFeeBps('maya')]).toEqual([0, 0, 0]);
    expect([NEAR_APP_FEE_BPS, THOR_AFFILIATE_BPS, ZAFU_FEE_OFF_PCT]).toEqual([0, 0, 100]);
    // the paid rate after the beta: 0.2% of a 0.5% list
    expect([ZAFU_PAID_FEE_BPS, Math.round(100 - (ZAFU_PAID_FEE_BPS * 100) / 50)]).toEqual([20, 60]);
  });

  it('adds every part into an estimated total', () => {
    const total = costOf([
      { label: 'network fee in', bps: 7, out: 300n },
      { label: 'thorchain', bps: 45, out: 1_900n },
      { label: 'zafu fee', bps: 10, out: 400n, zafu: true },
    ]);
    expect([total.bps, total.out]).toEqual([62, 2_600n]);
    expect([pct(62), pct(0), pct(10), pct(150)]).toEqual(['0.62%', '0%', '0.1%', '1.5%']);
  });
});

describe('router', () => {
  it('labels the best price, and says how far ahead it is', () => {
    expect(routeLabel('thor', true)).toBe('best price · thorchain');
    expect(routeLabel('near', true)).toBe('best price · near intents');
    expect(routeLabel('near', false)).toBe('near intents');
    expect(lead(rank([q('near', 100n), q('thor', 142n)]))).toBe(42n);
    expect(lead([q('thor', 142n), q('near', 999n, 'not available yet')])).toBeUndefined();
  });
});

describe('best route', () => {
  it('ranks by what arrives after every fee, zafu near fee included', async () => {
    allow.add('near-swap').add('thorchain');
    fee.recipient = 'zafu.near';
    // 1click nets its app fee into amountOut: 4.15 zec here beats thorchain's 4.12
    const ranked = async () =>
      rank(
        (await quoteEach(['near', 'thor'], req())).flatMap(s =>
          s.status === 'fulfilled' ? [s.value] : [],
        ),
      ).map(q => q.route);
    thornode(thorQuote());
    expect(await ranked()).toEqual(['near', 'thor']);
    thornode(thorQuote({ expected_amount_out: '416000000' }));
    expect(await ranked()).toEqual(['thor', 'near']);
  });

  it('merges the pickers, one row per token and chain', async () => {
    const tokens = await routeTokens(['near', 'thor']);
    expect(tokens.filter(t => t.symbol === 'BTC' && t.chain === 'btc')).toHaveLength(1);
    expect(tokens.some(t => t.symbol === 'DOGE')).toBe(true);
  });
});

// recorded from gateway.liquify.com/chain/thorchain_api on 2026-10-04: 0.1 / 1 btc into zec,
// affiliate zafu:20, liquidity_tolerance_bps 300 (the zec pool held ~0.35 zec)
const MIN_REFUSAL =
  'amount less than min swap amount (recommended_min_amount_in: 9258): invalid request';
const LIMIT_REFUSAL =
  'failed to simulate swap: failed to simulate handler: emit asset 137088 less than price limit 6482895646: invalid request';
const live01 = thorQuote({
  memo: `=:z:${T}:623969074/1/1080:zafu:20`,
  expected_amount_out: '643267087',
  recommended_min_amount_in: '9258',
  recommended_gas_rate: '6',
  max_streaming_quantity: 14400,
  streaming_swap_blocks: 1079,
  total_swap_seconds: 7074,
  fees: {
    asset: 'ZEC.ZEC',
    affiliate: '1289202',
    outbound: '44951',
    liquidity: '12496680',
    total: '13830833',
    slippage_bps: 190,
    total_bps: 210,
  },
});
const live1 = thorQuote({
  memo: `=:z:${T}:6294550476/1/0:zafu:20`,
  expected_amount_out: '6489227295',
  max_streaming_quantity: 14400,
  streaming_swap_blocks: 14399,
  total_swap_seconds: 86994,
  fees: {
    asset: 'ZEC.ZEC',
    affiliate: '13004554',
    outbound: '44951',
    liquidity: '95400000',
    total: '108449505',
    slippage_bps: 144,
    total_bps: 164,
  },
});
/** a node that answers each quote url as told; inbound addresses as recorded */
const node = (answer: (url: string) => [number, unknown]) => {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      urls.push(url);
      const [status, body] = url.includes('/quote/swap') ? answer(url) : [200, inbound()];
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }),
  );
  return urls;
};
const zeroOne = req({ amountIn: '0.1', otherAddress: '' });

describe('thorchain streaming, minimums and price limits', () => {
  it('asks again in parts that clear the minimum when its own streaming count refuses an amount it can fill', async () => {
    const urls = node(url =>
      url.includes('streaming_quantity') ? [200, live01] : [400, { message: MIN_REFUSAL }],
    );
    const quote = await thorProvider.quote(zeroOne);
    const asks = urls.filter(u => u.includes('/quote/swap')).map(u => new URL(u).searchParams);
    expect(asks).toHaveLength(2);
    expect(asks[0]!.has('streaming_quantity')).toBe(false);
    // 0.1 btc in parts of at least 9258 sat: 1080 parts
    expect(asks[1]!.get('streaming_quantity')).toBe('1080');
    expect(asks[1]!.get('liquidity_tolerance_bps')).toBe('300');
    expect(quote).toMatchObject({
      amountOutText: '6.43267',
      atLeastText: '6.23969',
      memo: `=:z:${T}:623969074/1/1080:zafu:20`,
      timeText: 'about 2 h',
      streamLine: 'streams over about 2 h · unfilled parts come back',
    });
    expect(new TextEncoder().encode(quote.memo).length).toBeLessThanOrEqual(80);
  });

  it('shows a real shortfall, and a retry that fails says its own reason', async () => {
    node(() => [400, { message: MIN_REFUSAL }]);
    await expect(thorProvider.quote(req({ amountIn: '0.00005' }))).rejects.toBeInstanceOf(
      BelowMinimum,
    );
    node(() => [400, { message: MIN_REFUSAL }]);
    await expect(thorProvider.quote(zeroOne)).rejects.toThrow(
      "thorchain can't fill this right now · its pool is too small",
    );
    node(url =>
      url.includes('streaming_quantity')
        ? [400, { message: LIMIT_REFUSAL }]
        : [400, { message: MIN_REFUSAL }],
    );
    const e = await thorProvider.quote(zeroOne).catch((x: unknown) => x);
    expect(plain('thor', e)).toBe("its zec pool can't fill this at a fair price");
  });

  it('signs only a memo with a price limit, and says a day-long stream as about 24 h', async () => {
    node(() => [200, live1]);
    const quote = await thorProvider.quote(req({ amountIn: '1', otherAddress: '' }));
    expect(quote).toMatchObject({
      atLeastText: '62.9455',
      timeText: 'about 24 h',
      streamLine: 'streams over about 24 h · unfilled parts come back',
    });
    expect(quote.memo).toContain(':zafu:20');
    expect(memoLimit(quote.memo!)).toBe(6_294_550_476n);
    expect(memoLimit('=:z:t1x:62945e5/1/0')).toBe(6_294_500_000n);
    // a quote whose memo fills at any price is never shown, so never signed
    node(() => [200, { ...live1, memo: `=:z:${T}:0/1/0:zafu:20` }]);
    await expect(thorProvider.quote(req({ amountIn: '1', otherAddress: '' }))).rejects.toThrow(
      "thorchain's quote carries no price limit · zafu won't sign it",
    );
  });
});

describe('thornode refusals, said plainly', () => {
  it('reads a minimum the amount already clears as a pool that cannot fill it', async () => {
    const { nodeRefusal } = await import('./thornode');
    const e = new Error(
      'amount less than min swap amount (recommended_min_amount_in: 6129): invalid request',
    );
    expect(nodeRefusal('thorchain', e, 1_000_000n, 'btc').message).toBe(
      "thorchain can't fill this right now · its pool is too small",
    );
  });
  it('a real shortfall says the minimum, in the asset', async () => {
    const { nodeRefusal, BelowMinimum } = await import('./thornode');
    const e = new Error(
      'amount less than min swap amount (recommended_min_amount_in: 6129): invalid request',
    );
    const r = nodeRefusal('thorchain', e, 5000n, 'btc');
    expect(r).toBeInstanceOf(BelowMinimum);
    expect(r.message).toBe('thorchain swaps 0.00006129 btc or more');
  });
  it('never shows the node raw text', async () => {
    const { nodeRefusal } = await import('./thornode');
    expect(
      nodeRefusal('maya', new Error('pool ZEC.ZEC not found: invalid request'), 1n, 'zec').message,
    ).toBe('maya could not quote this right now');
  });
});

describe('into zec, who a refund goes to', () => {
  const into = (symbol: string, chain: string): SwapPair => ({
    direction: 'into_zec',
    symbol,
    chain,
  });

  it('thorchain refunds the payer from an OP_RETURN chain; a memo chain names the address', () => {
    for (const [sym, chain] of [
      ['btc', 'btc'],
      ['ltc', 'ltc'],
      ['bch', 'bch'],
      ['doge', 'doge'],
    ] as const) {
      expect(refundsToPayer('thor', into(sym, chain))).toBe(true);
    }
    expect(refundsToPayer('thor', into('atom', 'gaia'))).toBe(false);
    expect(refundsToPayer('thor', into('xrp', 'xrp'))).toBe(false);
    expect(refundsToPayer('near', into('btc', 'btc'))).toBe(false);
    expect(refundsToPayer('maya', into('eth', 'eth'))).toBe(true);
    expect(refundsToPayer('thor', { ...into('btc', 'btc'), direction: 'from_zec' })).toBe(false);
  });

  it('thorchain asks no refund address of a btc payer; near says it needs one', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        urls.push(url);
        return Promise.resolve(
          new Response(
            JSON.stringify(url.includes('/inbound_addresses') ? inbound() : thorQuote()),
            { status: 200 },
          ),
        );
      }),
    );
    await thorProvider.quote(req({ otherAddress: '' }));
    expect(urls.find(u => u.includes('/quote/swap'))).not.toMatch(/refund_address/);
    await expect(nearProvider.quote(req({ otherAddress: '' }))).rejects.toBeInstanceOf(
      NeedsRefundAddress,
    );
  });
});
