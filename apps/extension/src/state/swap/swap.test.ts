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
    zafuFeeBps: (route: string) => real.zafuFeeBps(route, real.zafuListBps(fee.recipient)),
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
import { candidates, OFFERED, routeLabel, ROUTES } from './routes';
import {
  BelowMinimum,
  checkQuote as nodeCheckQuote,
  nameInMemo,
  nodeCost,
  nodeStatus,
  type InboundAddress,
  type NodeQuote,
} from './thornode';
import { thorProvider } from './thor';
import { mayaProvider } from './maya';
import { nearCost, nearProvider } from './near';
import { quoteRoutes, routeTokens } from '.';

const checkQuote = (
  ...a: Parameters<typeof nodeCheckQuote> extends [string, ...infer R] ? R : never
) => nodeCheckQuote('thorchain', ...a);
const thorStatus = (s: Parameters<typeof nodeStatus>[0]) => nodeStatus(s, 'thorchain');
const thorCost = (...a: Parameters<typeof nodeCost> extends [string, ...infer R] ? R : never) =>
  nodeCost('thorchain', ...a);

const NOW = 1_790_000_000;
const T = 't1PTs8DQifJxg6HmUq7AgYYFNkbyQa1zjgf';
const ZEC_VAULT = 't1ZecVaultxxxxxxxxxxxxxxxxxxxxxxxx';
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
  memo: `=:ZEC.ZEC:${T}/bc1qrefundexample:0/1/0`,
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
      memo: `=:ZEC.ZEC:${T}/bc1qrefundexample:0/1/0`,
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
        memo: '=:BTC.BTC:bc1qdestexample:0/1/0',
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

  it('costs a swap from the quote: the fee in, thorchain, and zafu at 0', async () => {
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
    // no affiliate is ever asked for
    const urls = thornode(thorQuote());
    await thorProvider.quote(req());
    expect(urls.join()).not.toContain('affiliate');

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

  describe('a thorname as the destination', () => {
    const ETH_ADDR = '0x90A48D5CF7343B08dA12E067680B4C6dbfE551Be';
    const ETH = { symbol: 'ETH', chain: 'eth', decimals: 18 };
    const long = `=:ETH.ETH:${ETH_ADDR}:${'9'.repeat(20)}/1/0:zafu-affiliate:15`;
    const out = (memo: string) =>
      thornode(thorQuote({ inbound_address: ZEC_VAULT, memo }), [inbound()[0]!]);

    it('names the destination only when the address does not fit the op_return', () => {
      expect(nameInMemo(long, ETH_ADDR, 'alice')).toBe(
        `=:ETH.ETH:alice:${'9'.repeat(20)}/1/0:zafu-affiliate:15`,
      );
      const short = `=:ETH.ETH:${ETH_ADDR}:0/1/0`;
      expect(nameInMemo(short, ETH_ADDR, 'alice')).toBe(short);
      expect(nameInMemo(long, ETH_ADDR)).toBe(long);
      // never over a memo that pays some other address
      expect(nameInMemo(long, '0xsomeoneelse', 'alice')).toBe(long);
    });

    it('quotes the resolved address and carries the name in the memo', async () => {
      const urls = out(long);
      const quote = await thorProvider.quote(
        req({ direction: 'from_zec', token: ETH, otherAddress: ETH_ADDR, otherName: 'alice' }),
      );
      // thornode is asked about the address the user saw, never the name
      expect(urls.find(u => u.includes('/quote/swap'))).toContain(`destination=${ETH_ADDR}`);
      expect(quote.memo).toBe(`=:ETH.ETH:alice:${'9'.repeat(20)}/1/0:zafu-affiliate:15`);
      expect(quote.recipient).toBe(ETH_ADDR);
    });

    it('keeps the address when the memo already fits', async () => {
      out(`=:ETH.ETH:${ETH_ADDR}:0/1/0`);
      const quote = await thorProvider.quote(
        req({ direction: 'from_zec', token: ETH, otherAddress: ETH_ADDR, otherName: 'alice' }),
      );
      expect(quote.memo).toBe(`=:ETH.ETH:${ETH_ADDR}:0/1/0`);
    });

    it('never puts a name in the refund slot, and a btc deposit refunds to its sender', async () => {
      const urls = thornode(thorQuote());
      await thorProvider.quote(req({ otherAddress: 'bc1qrefundexample', otherName: 'alice' }));
      const asked = urls.find(u => u.includes('/quote/swap'))!;
      // dest/refund would not fit btc's 80-byte OP_RETURN; thorchain refunds the sender
      expect(asked).not.toContain('refund_address');
      expect(asked).not.toContain('alice');
    });
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
  memo: `=:z:${T}:0/1/0`,
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
  memo: '=:b:bc1qdest:0/1/0',
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
    await quoteRoutes(candidates({ direction: 'into_zec', symbol: 'btc', chain: 'btc' }), req());
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
    });
    expect(quote).toMatchObject({
      route: 'maya',
      amountOut: 63_176_359n,
      amountOutText: '0.63176359',
      timeText: '~10 min',
      depositAddress: MAYA_BTC_VAULT,
      memo: `=:z:${T}:0/1/0`,
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
    const out = req({ direction: 'from_zec', otherAddress: 'bc1qdest', otherName: 'alice' });
    expect(await mayaProvider.quote(out)).toMatchObject({
      amountOut: 1_574_493n,
      depositAddress: MAYA_ZEC_VAULT,
      // maya resolves mayanames, so a thorname never stands in for the address
      memo: '=:b:bc1qdest:0/1/0',
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
    expect(near.requestQuote).toHaveBeenLastCalledWith(expect.objectContaining({ appFeeBps: 10 }));
    expect(quote.cost?.parts.at(-1)).toMatchObject({ label: 'zafu fee', bps: 10, zafu: true });
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
  it('is the near rate less any discount, inert without a recipient, and 0 on thorchain', async () => {
    const { zafuFeeBps, zafuListBps } =
      await vi.importActual<typeof import('../../config/swap-fee')>('../../config/swap-fee');
    expect(zafuListBps('', 10)).toBe(0);
    expect(zafuListBps('zafu.near', 10)).toBe(10);
    expect(zafuFeeBps('near', 10)).toBe(10);
    expect(zafuFeeBps('near', 10, 50)).toBe(5);
    expect(zafuFeeBps('thor', 10)).toBe(0);
    expect(zafuFeeBps('near', 0)).toBe(0);
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

  it('ranks by what arrives after every fee, zafu near fee included', async () => {
    allow.add('near-swap').add('thorchain');
    fee.recipient = 'zafu.near';
    // 1click nets its app fee into amountOut: 4.15 zec here beats thorchain's 4.12
    thornode(thorQuote());
    expect((await quoteRoutes(['near', 'thor'], req())).map(r => r.route)).toEqual([
      'near',
      'thor',
    ]);
    thornode(thorQuote({ expected_amount_out: '416000000' }));
    expect((await quoteRoutes(['near', 'thor'], req())).map(r => r.route)).toEqual([
      'thor',
      'near',
    ]);
  });

  it('merges the pickers, one row per token and chain', async () => {
    const tokens = await routeTokens(['near', 'thor']);
    expect(tokens.filter(t => t.symbol === 'BTC' && t.chain === 'btc')).toHaveLength(1);
    expect(tokens.some(t => t.symbol === 'DOGE')).toBe(true);
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
