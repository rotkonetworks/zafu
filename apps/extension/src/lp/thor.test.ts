import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const view = vi.hoisted(() => ({ on: new Set<string>() }));
vi.mock('../net/egress-opt-in', () => ({
  readEgressView: () =>
    Promise.resolve(['thorchain', 'midgard', 'near-swap'].map(id => ({ id, on: view.on.has(id) }))),
}));
vi.mock('../state/swap/near', () => ({
  nearPrices: () => Promise.resolve(new Map([['ZEC@zec', 1318.33]])),
}));

import {
  DISAGREE_LINE,
  historyOf,
  ONE_NODE_LINE,
  lpEgress,
  NotAllowed,
  pausesOf,
  readMarketZec,
  readMidgard,
  readThor,
  readTxSeen,
  readVault,
  txSeenOf,
  zecInboundOf,
} from './thor';

const LP = 't1JVSs2H78EhKL9ykgVVbSNLM918dKqutEK';

/** live answers, 2026-10-05 (trimmed) */
const LIVE: Record<string, unknown> = {
  '/thorchain/pool/ZEC.ZEC': {
    asset: 'ZEC.ZEC',
    status: 'Available',
    pending_inbound_rune: '0',
    balance_asset: '1884160158',
    balance_rune: '3199743901909',
    pool_units: '3168071014120',
    trading_halted: false,
  },
  '/thorchain/inbound_addresses': [
    { chain: 'BTC', address: 'bc1q', halted: false },
    {
      chain: 'ZEC',
      address: 'tex1h55z0mdpnaxjxqs39sht9659ztnjk32reer52v',
      halted: false,
      chain_lp_actions_paused: false,
      outbound_fee: '44929',
      dust_threshold: '15000',
    },
  ],
  '/thorchain/mimir': { L1SLIPMINBPS: 10, LIQUIDITYLOCKUPBLOCKS: 600, PAUSELP: 0 },
  '/thorchain/network': { rune_price_in_tor: '78017178' },
  '/thorchain/lastblock/ZEC': [{ chain: 'ZEC', thorchain: 28108921 }],
  [`/thorchain/pool/ZEC.ZEC/liquidity_provider/${LP}`]: {
    units: '8504694842',
    pending_asset: '0',
    rune_deposit_value: '7528163785',
    asset_deposit_value: '5750000',
    last_add_height: 28096435,
    luvi_growth_pct: '0.001848054821129876',
  },
};

let fetched: string[] = [];
beforeEach(() => {
  view.on = new Set();
  fetched = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      fetched.push(url);
      const path = new URL(url).pathname.replace('/chain/thorchain_api', '');
      return Promise.resolve(new Response(JSON.stringify(LIVE[path] ?? {}), { status: 200 }));
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('egress: nothing leaves before the person allowed it', () => {
  it('asks nothing while thornode, midgard and prices are off', async () => {
    expect(await lpEgress()).toEqual({ thornode: false, midgard: false, prices: false });
    await expect(readThor(LP)).rejects.toBeInstanceOf(NotAllowed);
    await expect(readTxSeen('ab', LP)).rejects.toBeInstanceOf(NotAllowed);
    await expect(readMidgard(LP)).rejects.toBeInstanceOf(NotAllowed);
    expect(await readMarketZec()).toBeUndefined();
    expect(fetched).toEqual([]);
  });

  it('thornode allowed: thornode only, liquify first', async () => {
    view.on.add('thorchain');
    const r = await readThor(LP);
    expect(
      fetched.every(u => u.startsWith('https://gateway.liquify.com/chain/thorchain_api/')),
    ).toBe(true);
    await expect(readMidgard()).rejects.toBeInstanceOf(NotAllowed);
    expect(fetched.some(u => u.includes('midgard'))).toBe(false);
    expect(r.pool.asset).toBe(1_884_160_158n);
    expect(r.pool.units).toBe(3_168_071_014_120n);
    expect(r.minSlipBps).toBe(10n);
    expect(r.lockupBlocks).toBe(600);
    expect(r.height).toBe(28_108_921);
    expect(r.runeUsd).toBeCloseTo(0.78017178);
    expect(r.pool.zecUsd).toBeCloseTo(1324.9, 0);
    expect(r.inbound?.dust).toBe(15_000n);
    expect(r.addPaused).toBeUndefined();
    expect(r.position?.units).toBe(8_504_694_842n);
    expect(r.position?.depositAsset).toBe(5_750_000n);
  });

  it("prices only from the swap's own list, once near-swap is allowed", async () => {
    view.on.add('near-swap');
    expect(await readMarketZec()).toBe(1318.33);
  });
});

describe('pauses', () => {
  const inbound = zecInboundOf(LIVE['/thorchain/inbound_addresses'] as never)!;
  it('reads the zec vault, its dust and its fee', () => {
    expect(inbound.address).toMatch(/^tex1/);
    expect(inbound.outboundFee).toBe(44_929n);
  });
  it('tells adds from take-outs', () => {
    expect(pausesOf({}, inbound)).toEqual({ addPaused: undefined, outPaused: undefined });
    expect(pausesOf({ 'PAUSELPDEPOSIT-ZEC-ZEC': 1 }, inbound)).toEqual({
      addPaused: 'mimir',
      outPaused: undefined,
    });
    expect(pausesOf({ PAUSELP: 1 }, inbound)).toEqual({ addPaused: 'mimir', outPaused: 'mimir' });
    expect(pausesOf({}, { ...inbound, lpPaused: true })).toEqual({
      addPaused: 'chain',
      outPaused: 'chain',
    });
    expect(pausesOf({}, { ...inbound, halted: true }).addPaused).toBe('halted');
  });
});

describe('tx status', () => {
  it('reads a refund to the lp address', () => {
    const s = txSeenOf(
      {
        stages: { inbound_observed: { completed: true }, inbound_finalised: { completed: true } },
        planned_out_txs: [
          { to_address: LP, coin: { asset: 'ZEC.ZEC', amount: '955000' }, refund: true },
        ],
        out_txs: [
          {
            id: 'F4B6B0834AEAF0ABCED009053741EDDA6CE556D465F8D7D6249082CD06EA7FCD',
            to_address: LP,
            coins: [{ asset: 'ZEC.ZEC', amount: '955000' }],
            memo: 'REFUND:AB',
          },
        ],
      },
      LP,
    );
    expect(s).toEqual({
      observed: true,
      finalised: true,
      out: {
        zat: 955_000n,
        refund: true,
        txid: 'f4b6b0834aeaf0abced009053741edda6ce556d465f8d7d6249082cd06ea7fcd',
      },
    });
  });

  it("waits for the payout's own txid: the zero id is not one", () => {
    const s = txSeenOf(
      {
        stages: { inbound_observed: { completed: true } },
        planned_out_txs: [{ to_address: LP, coin: { asset: 'ZEC.ZEC', amount: '919000' } }],
        out_txs: [
          { id: '0'.repeat(64), to_address: LP, coins: [{ asset: 'ZEC.ZEC', amount: '1' }] },
        ],
      },
      LP,
    );
    expect(s.out).toEqual({ zat: 919_000n, refund: false, txid: undefined });
    expect(txSeenOf({}, LP)).toEqual({ observed: false, finalised: false, out: undefined });
  });

  it('asks THORNode with the txid upper-cased', async () => {
    view.on.add('thorchain');
    await readTxSeen('abcdef', LP);
    expect(fetched[0]).toMatch(/\/tx\/status\/ABCDEF$/);
  });
});

describe('history', () => {
  it('reads adds, take-outs and refunds of one address', () => {
    const rows = historyOf(
      {
        actions: [
          {
            date: '1791100080251606657',
            type: 'addLiquidity',
            in: [{ address: LP, coins: [{ asset: 'ZEC.ZEC', amount: '11500000' }], txID: 'AB' }],
            metadata: { addLiquidity: { memo: '+:ZEC.ZEC' } },
          },
          {
            date: '1791103290278486789',
            type: 'refund',
            in: [{ address: LP, coins: [{ asset: 'ZEC.ZEC', amount: '3637133' }], txID: 'CD' }],
            metadata: { refund: { memo: '+:ZEC.ZEC', reason: 'pool paused' } },
          },
        ],
      },
      LP,
    );
    expect(rows).toEqual([
      {
        kind: 'add',
        at: 1791100080251,
        zat: 11_500_000n,
        memo: '+:ZEC.ZEC',
        txid: 'ab',
        reason: undefined,
      },
      {
        kind: 'refund',
        at: 1791103290278,
        zat: 3_637_133n,
        memo: '+:ZEC.ZEC',
        txid: 'cd',
        reason: 'pool paused',
      },
    ]);
  });
});

describe('the vault, from more than one operator', () => {
  /** each operator's answers, keyed by host */
  const serve = (per: Record<string, Record<string, unknown> | 'down'>) =>
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        fetched.push(url);
        const u = new URL(url);
        const host = per[u.host] ?? {};
        if (host === 'down') {
          return Promise.reject(new TypeError('failed to fetch'));
        }
        const path = u.pathname.replace('/chain/thorchain_api', '');
        return Promise.resolve(
          new Response(JSON.stringify(host[path] ?? LIVE[path] ?? {}), { status: 200 }),
        );
      }),
    );
  const rows = LIVE['/thorchain/inbound_addresses'] as Record<string, unknown>[];
  const withZec = (patch: Record<string, unknown>) =>
    rows.map(r => (r['chain'] === 'ZEC' ? { ...r, ...patch } : r));

  it('asks both operators, and takes the vault when they agree', async () => {
    view.on.add('thorchain');
    serve({});
    const v = await readVault();
    expect(v.inbound.address).toBe(zecInboundOf(rows as never)!.address);
    expect(fetched.some(u => u.includes('ninerealms'))).toBe(true);
    expect(fetched.some(u => u.includes('liquify'))).toBe(true);
  });

  it('refuses when one operator names another vault', async () => {
    view.on.add('thorchain');
    serve({
      'gateway.liquify.com': {
        '/thorchain/inbound_addresses': withZec({ address: 't1PTs8DQifJxg6HmUq7AgYYFNkbyQa1zjgf' }),
      },
    });
    await expect(readVault()).rejects.toThrow(DISAGREE_LINE);
  });

  it('refuses when the operators disagree on a pause', async () => {
    view.on.add('thorchain');
    serve({
      'thornode.ninerealms.com': {
        '/thorchain/mimir': { ...(LIVE['/thorchain/mimir'] as object), PAUSELPZEC: 1 },
      },
    });
    await expect(readVault()).rejects.toThrow(DISAGREE_LINE);
  });

  it('refuses when only one operator answers', async () => {
    view.on.add('thorchain');
    serve({ 'thornode.ninerealms.com': 'down' });
    await expect(readVault()).rejects.toThrow(ONE_NODE_LINE);
  });

  it('takes the higher dust of the two', async () => {
    view.on.add('thorchain');
    serve({
      'thornode.ninerealms.com': {
        '/thorchain/inbound_addresses': withZec({ dust_threshold: '20000' }),
      },
    });
    expect((await readVault()).inbound.dust).toBe(20_000n);
  });
});
