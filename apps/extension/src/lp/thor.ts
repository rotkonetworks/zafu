/**
 * What lp.html reads, and from whom: THORNode for the pool, its vault, the
 * pauses and a position; Midgard for activity and an address's history; the
 * swap's market list (near intents) for zec's price. Each read first checks
 * its own destination in the egress policy and asks nothing when it is off:
 * no request leaves before the person allowed it, and nothing here runs on
 * the popup's home (it shows the cached last read).
 */

import { readEgressView } from '../net/egress-opt-in';
import { thornodeGet, THORNODE_URLS } from '../services/thornode';
import { nearPrices } from '../state/swap/near';
import { LP_POOL, type PoolDepth } from './math';
import { MIDGARD_URL } from '../services/midgard';

/** THORNode's api as a destination: liquify answers, the other is failover */
export const THORNODE_DEST = 'thorchain';
/** THORChain's indexer: activity, earnings, an address's history */
export const MIDGARD_DEST = 'midgard';
/** the market price the swap measures against */
export const PRICES_DEST = 'near-swap';

/** a read was not made: its destination is off */
export class NotAllowed extends Error {
  constructor(readonly destination: string) {
    super(`${destination} is off`);
  }
}

export interface LpEgress {
  thornode: boolean;
  midgard: boolean;
  prices: boolean;
}

/** which of the three may be asked right now */
export const lpEgress = async (): Promise<LpEgress> => {
  const view = await readEgressView();
  const on = (id: string) => !!view.find(d => d.id === id)?.on;
  return { thornode: on(THORNODE_DEST), midgard: on(MIDGARD_DEST), prices: on(PRICES_DEST) };
};

const big = (v: unknown): bigint => {
  try {
    return BigInt(String(v ?? '0').split('.')[0] || '0');
  } catch {
    return 0n;
  }
};

/** the zec vault and its chain flags */
export interface ZecInbound {
  address: string;
  halted: boolean;
  lpPaused: boolean;
  dust: bigint;
  outboundFee: bigint;
}

export interface Position {
  units: bigint;
  pendingAsset: bigint;
  /** the add's value on each side, at the add's own pool price (THORNode deposit values) */
  depositAsset: bigint;
  depositRune: bigint;
  lastAddHeight: number;
  /** pool growth per unit since the add: what fees did */
  luviGrowthPct: number;
}

export interface ThorRead {
  at: number;
  pool: PoolDepth & {
    status: string;
    tradingHalted: boolean;
    pendingRune: bigint;
    /** the pool's own zec price, usd */
    zecUsd: number;
  };
  inbound?: ZecInbound;
  /** adds refused right now, and by whom */
  addPaused?: 'mimir' | 'chain' | 'halted';
  /** withdraws refused right now */
  outPaused?: 'mimir' | 'chain' | 'halted';
  minSlipBps: bigint;
  runeUsd: number;
  lockupBlocks: number;
  /** thorchain's block height */
  height: number;
  position?: Position;
}

type Raw = Record<string, unknown>;

const node = <T>(path: string, signal?: AbortSignal) =>
  thornodeGet<T>(`/thorchain${path}`, THORNODE_URLS, signal);

/** the mimir keys that stop zec liquidity: everyone's, the chain's, or adds to this pool */
export const pausesOf = (
  mimir: Record<string, number>,
  inbound?: ZecInbound,
): Pick<ThorRead, 'addPaused' | 'outPaused'> => {
  const on = (k: string) => (mimir[k] ?? 0) > 0;
  const all = on('PAUSELP') || on('PAUSELPZEC') ? 'mimir' : undefined;
  const chain = inbound?.halted ? 'halted' : inbound?.lpPaused ? 'chain' : undefined;
  const out = all ?? chain;
  return { outPaused: out, addPaused: out ?? (on('PAUSELPDEPOSIT-ZEC-ZEC') ? 'mimir' : undefined) };
};

/** one inbound_addresses row, as the page keeps it */
export const zecInboundOf = (rows: Raw[]): ZecInbound | undefined => {
  const z = rows.find(r => r['chain'] === 'ZEC');
  return z
    ? {
        address: String(z['address'] ?? ''),
        halted: !!z['halted'],
        lpPaused: !!z['chain_lp_actions_paused'],
        dust: big(z['dust_threshold']),
        outboundFee: big(z['outbound_fee']),
      }
    : undefined;
};

/** everything THORNode says about the pool, and about `address` when given */
export const readThor = async (address?: string, signal?: AbortSignal): Promise<ThorRead> => {
  if (!(await lpEgress()).thornode) {
    throw new NotAllowed(THORNODE_DEST);
  }
  const [pool, inbound, mimir, network, last, lp] = await Promise.all([
    node<Raw>(`/pool/${LP_POOL}`, signal),
    node<Raw[]>('/inbound_addresses', signal),
    node<Record<string, number>>('/mimir', signal),
    node<Raw>('/network', signal),
    node<Raw[]>('/lastblock/ZEC', signal),
    address ? node<Raw>(`/pool/${LP_POOL}/liquidity_provider/${address}`, signal) : undefined,
  ]);
  const zec = zecInboundOf(inbound);
  const asset = big(pool['balance_asset']);
  const rune = big(pool['balance_rune']);
  const runeUsd = Number(big(network['rune_price_in_tor'])) / 1e8;
  return {
    at: Date.now(),
    pool: {
      asset,
      rune,
      units: big(pool['pool_units']),
      status: String(pool['status'] ?? ''),
      tradingHalted: !!pool['trading_halted'],
      pendingRune: big(pool['pending_inbound_rune']),
      zecUsd: asset ? (Number(rune) / Number(asset)) * runeUsd : 0,
    },
    inbound: zec,
    ...pausesOf(mimir, zec),
    minSlipBps: BigInt(mimir['L1SLIPMINBPS'] ?? 0),
    runeUsd,
    lockupBlocks: mimir['LIQUIDITYLOCKUPBLOCKS'] ?? 0,
    height: Number(last[0]?.['thorchain'] ?? 0),
    position: lp && {
      units: big(lp['units']),
      pendingAsset: big(lp['pending_asset']),
      depositAsset: big(lp['asset_deposit_value']),
      depositRune: big(lp['rune_deposit_value']),
      lastAddHeight: Number(lp['last_add_height'] ?? 0),
      luviGrowthPct: Number(lp['luvi_growth_pct'] ?? 0) * 100,
    },
  };
};

export const ONE_NODE_LINE =
  'only one thorchain node answered, so the vault could not be checked · nothing was sent · please try again in a minute';
export const DISAGREE_LINE =
  'the thorchain nodes disagree about the zec vault or its pauses · nothing was sent · please try again in a minute';

/** a vault view, compared field by field across nodes */
const sameVault = (
  a: { inbound: ZecInbound } & Pick<ThorRead, 'addPaused' | 'outPaused'>,
  b: { inbound: ZecInbound } & Pick<ThorRead, 'addPaused' | 'outPaused'>,
) =>
  a.inbound.address === b.inbound.address &&
  a.inbound.halted === b.inbound.halted &&
  a.inbound.lpPaused === b.inbound.lpPaused &&
  a.addPaused === b.addPaused &&
  a.outPaused === b.outPaused;

/**
 * A fresh look at the vault and the pauses, right before zec moves, from
 * every THORNode operator zafu knows (ninerealms and liquify, both under the
 * one thornode destination), each asked on its own. One that does not
 * answer, or two that disagree on the vault or a pause, refuse: no single
 * operator decides where the zec goes. The dust is the higher of the two.
 */
export const readVault = async (
  signal?: AbortSignal,
  urls: readonly string[] = THORNODE_URLS,
): Promise<{ inbound: ZecInbound } & Pick<ThorRead, 'addPaused' | 'outPaused'>> => {
  if (!(await lpEgress()).thornode) {
    throw new NotAllowed(THORNODE_DEST);
  }
  const views = await Promise.all(
    urls.map(async base => {
      const [rows, mimir] = await Promise.all([
        thornodeGet<Raw[]>('/thorchain/inbound_addresses', [base], signal),
        thornodeGet<Record<string, number>>('/thorchain/mimir', [base], signal),
      ]);
      const inbound = zecInboundOf(Array.isArray(rows) ? rows : []);
      return inbound?.address ? { inbound, ...pausesOf(mimir, inbound) } : undefined;
    }),
  ).catch((e: unknown) => {
    throw signal?.aborted ? e : new Error(ONE_NODE_LINE);
  });
  if (views.some(v => !v)) {
    throw new Error('thorchain has no zec vault right now · nothing was sent');
  }
  const [first, ...rest] = views as NonNullable<(typeof views)[number]>[];
  if (!first || urls.length < 2) {
    throw new Error(ONE_NODE_LINE);
  }
  if (rest.some(v => !sameVault(first, v))) {
    throw new Error(DISAGREE_LINE);
  }
  const dust = views.reduce((m, v) => (v!.inbound.dust > m ? v!.inbound.dust : m), 0n);
  return { ...first, inbound: { ...first.inbound, dust } };
};

/** a deposit as THORChain sees it: observed, finalised, and what it sends back to `to` */
export interface TxSeen {
  observed: boolean;
  finalised: boolean;
  /** zec coming back to `to`: a refund, or a withdraw's payout */
  out?: { zat: bigint; refund: boolean; txid?: string };
}

const NO_TXID = /^0+$/;

/** tx/status, read for one of our own deposits; `to` is the lp address */
export const txSeenOf = (body: Raw, to: string): TxSeen => {
  const stages = (body['stages'] ?? {}) as Record<string, { completed?: boolean }>;
  const planned = ((body['planned_out_txs'] ?? []) as Raw[]).find(
    o => o['to_address'] === to && (o['coin'] as Raw | undefined)?.['asset'] === LP_POOL,
  );
  const sent = ((body['out_txs'] ?? []) as Raw[]).find(
    o =>
      o['to_address'] === to &&
      ((o['coins'] ?? []) as Raw[]).some(c => c['asset'] === LP_POOL) &&
      !NO_TXID.test(String(o['id'] ?? '0')),
  );
  const zat = sent
    ? big(((sent['coins'] as Raw[]).find(c => c['asset'] === LP_POOL) ?? {})['amount'])
    : planned
      ? big((planned['coin'] as Raw)['amount'])
      : undefined;
  return {
    observed: !!stages['inbound_observed']?.completed,
    finalised: !!stages['inbound_finalised']?.completed,
    out:
      zat === undefined
        ? undefined
        : {
            zat,
            refund: !!planned?.['refund'] || String(sent?.['memo'] ?? '').startsWith('REFUND:'),
            txid: sent ? String(sent['id']).toLowerCase() : undefined,
          },
  };
};

/** THORNode keys txids upper case; the zcash backend shows them lower */
export const readTxSeen = async (txid: string, to: string, signal?: AbortSignal) => {
  if (!(await lpEgress()).thornode) {
    throw new NotAllowed(THORNODE_DEST);
  }
  return txSeenOf(await node<Raw>(`/tx/status/${txid.toUpperCase()}`, signal), to);
};

const midgard = async <T>(path: string, signal?: AbortSignal): Promise<T> => {
  if (!(await lpEgress()).midgard) {
    throw new NotAllowed(MIDGARD_DEST);
  }
  const r = await fetch(`${MIDGARD_URL}/v2${path}`, { signal });
  if (r.status === 404) {
    return {} as T;
  }
  if (!r.ok) {
    throw new Error(`midgard ${r.status}`);
  }
  return (await r.json()) as T;
};

export interface HistoryRow {
  kind: 'add' | 'withdraw' | 'refund' | 'other';
  at: number;
  /** zat in (an add, a refund's deposit) or out (a payout) */
  zat: bigint;
  memo: string;
  txid: string;
  reason?: string;
}

/** midgard actions, read for one address: adds, take-outs and refunds */
export const historyOf = (body: Raw, address: string): HistoryRow[] =>
  ((body['actions'] ?? []) as Raw[]).map(a => {
    const type = String(a['type']);
    const meta = ((a['metadata'] ?? {}) as Record<string, Raw>)[type] ?? {};
    const coins = (side: string) =>
      ((a[side] ?? []) as Raw[])
        .filter(t => t['address'] === address)
        .flatMap(t => (t['coins'] ?? []) as Raw[])
        .filter(c => c['asset'] === LP_POOL)
        .reduce((n, c) => n + big(c['amount']), 0n);
    const into = ((a['in'] ?? []) as Raw[]).find(t => t['address'] === address);
    return {
      kind:
        type === 'addLiquidity'
          ? 'add'
          : type === 'withdraw'
            ? 'withdraw'
            : type === 'refund'
              ? 'refund'
              : 'other',
      at: Number(big(a['date']) / 1_000_000n),
      zat: type === 'withdraw' ? coins('out') : coins('in'),
      memo: String(meta['memo'] ?? ''),
      txid: String(into?.['txID'] ?? '').toLowerCase(),
      reason: meta['reason'] === undefined ? undefined : String(meta['reason']),
    };
  });

export interface MidgardRead {
  at: number;
  volume24hRune: bigint;
  fees7dRune: bigint;
  providers: number;
  /** the first day the pool had depth: its age, for the apr line */
  since?: number;
  history?: HistoryRow[];
}

export const readMidgard = async (address?: string, signal?: AbortSignal): Promise<MidgardRead> => {
  const [pool, earnings, depths, actions] = await Promise.all([
    midgard<Raw>(`/pool/${LP_POOL}`, signal),
    midgard<{ meta?: { pools?: Raw[] } }>('/history/earnings?interval=day&count=7', signal),
    midgard<{ meta?: Raw; intervals?: Raw[] }>(
      `/history/depths/${LP_POOL}?interval=day&count=400`,
      signal,
    ),
    address ? midgard<Raw>(`/actions?address=${address}&limit=50`, signal) : undefined,
  ]);
  const first = (depths.intervals ?? []).find(i => big(i['assetDepth']) > 0n);
  return {
    at: Date.now(),
    volume24hRune: big(pool['volume24h']),
    fees7dRune: big(
      (earnings.meta?.pools ?? []).find(p => p['pool'] === LP_POOL)?.['totalLiquidityFeesRune'],
    ),
    providers: Number(depths.meta?.['endMemberCount'] ?? 0),
    since: first ? Number(first['startTime']) * 1000 : undefined,
    history: actions && address ? historyOf(actions, address) : undefined,
  };
};

/** THORChain's reason for sending one deposit back, when Midgard may be asked */
export const readRefundReason = async (txid: string, address: string) =>
  historyOf(await midgard<Raw>(`/actions?txid=${txid.toUpperCase()}`), address).find(
    h => h.kind === 'refund',
  )?.reason;

/** zec in usd from the swap's own market list; undefined when it may not be asked */
export const readMarketZec = async (): Promise<number | undefined> =>
  (await lpEgress()).prices ? (await nearPrices()).get('ZEC@zec') : undefined;
