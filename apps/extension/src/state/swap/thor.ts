/**
 * THORChain as a swap route, over the THORNode HTTP API.
 *
 * There is no deposit address per swap: the payer sends to the source chain's
 * current vault with the swap instruction as a memo, and THORChain pays out
 * (or refunds) on the other side. Its zcash client is transparent only: ZEC
 * arrives at a t-address, and ZEC sent in must be a t->t transaction carrying
 * the memo in an OP_RETURN, refunded to the address that funded vin[0]. Only a
 * signer that holds the key and shows the memo signs that (CAPS.opReturn); for
 * every other wallet, from-zec quotes are shown for comparison and marked not
 * yet.
 *
 * All THORChain amounts are 1e8 fixed point, whatever the asset's decimals.
 */

import { requestEgressOptIn } from '../../net/egress-opt-in';
import { ThornodeRefusal, thornodeGet } from '../../services/thornode';
import {
  fromUnits,
  rescale,
  toUnits,
  costOf,
  type Cost,
  type Quote,
  type SwapProvider,
  type SwapStatusView,
} from './provider';
import { ROUTES, THOR_ASSETS, thorAsset } from './routes';

export const ZEC_ASSET = 'ZEC.ZEC';
const ZEC_CHAIN = 'ZEC';
const THOR_DECIMALS = 8;
/** THORChain's observers relay at most 80 bytes of OP_RETURN, and zcash allows no more */
export const MAX_MEMO_BYTES = 80;

export interface InboundAddress {
  chain: string;
  address: string;
  halted: boolean;
  global_trading_paused: boolean;
  chain_trading_paused: boolean;
  dust_threshold?: string;
  /** what thorchain charges to send this chain's gas asset out (a refund, here), 1e8 */
  outbound_fee?: string;
}

/** /thorchain/quote/swap; every fee is in `fees.asset`, the output asset, 1e8 */
export interface ThorQuote {
  inbound_address: string;
  /** unix seconds */
  expiry: number;
  memo: string;
  /** after the swap, affiliate and outbound fees */
  expected_amount_out: string;
  /** in the inbound asset, 1e8: below it a refund may not cover its own fee */
  recommended_min_amount_in?: string;
  dust_threshold?: string;
  /** the fast rate for the inbound transaction, in `gas_rate_units` */
  recommended_gas_rate?: string;
  gas_rate_units?: string;
  total_swap_seconds?: number;
  max_streaming_quantity?: number;
  streaming_swap_blocks?: number;
  router?: string;
  fees: {
    asset: string;
    affiliate?: string;
    liquidity?: string;
    outbound?: string;
    total: string;
    slippage_bps?: number;
    total_bps?: number;
  };
}

const thorFetch = async <T>(path: string): Promise<T> => {
  await requestEgressOptIn(ROUTES.thor.egress);
  return thornodeGet<T>(path);
};

interface ThorTxStatus {
  out_txs?: { memo?: string }[];
  stages?: {
    inbound_observed?: { completed: boolean };
    inbound_finalised?: { completed: boolean };
    swap_status?: { pending: boolean };
    swap_finalised?: { completed: boolean };
    outbound_signed?: { completed: boolean };
  };
}

const STATUS = {
  unseen: { phase: 'waiting', line: 'waiting for thorchain to see the deposit' },
  confirming: { phase: 'waiting', line: 'deposit seen, confirming' },
  swapping: { phase: 'processing', line: 'swapping' },
  sending: { phase: 'processing', line: 'sending to the recipient' },
  done: { phase: 'done', line: 'swap complete' },
  refunded: { phase: 'failed', line: 'thorchain refunded the zec to your transparent address' },
} as const satisfies Record<string, SwapStatusView>;

/** where a deposit is, from thornode's stages */
export const thorStatus = (s: ThorTxStatus): SwapStatusView => {
  const st = s.stages;
  const stage: keyof typeof STATUS = !st?.inbound_observed?.completed
    ? 'unseen'
    : !st.inbound_finalised?.completed
      ? 'confirming'
      : s.out_txs?.some(o => o.memo?.toUpperCase().startsWith('REFUND'))
        ? 'refunded'
        : st.swap_status?.pending || !st.swap_finalised?.completed
          ? 'swapping'
          : // a swap into a native thorchain asset has no outbound stage
            st.outbound_signed && !st.outbound_signed.completed
            ? 'sending'
            : 'done';
  return STATUS[stage];
};

const memoBytes = (memo: string) => new TextEncoder().encode(memo).length;

const open = (a: InboundAddress | undefined) =>
  !!a && !a.halted && !a.global_trading_paused && !a.chain_trading_paused;

/** throws a calm line unless zec and the source chain both trade right now */
export const checkOpen = (inbound: InboundAddress[], sourceChain: string): InboundAddress => {
  const source = inbound.find(a => a.chain === sourceChain);
  for (const [chain, a] of [
    [ZEC_CHAIN, inbound.find(a => a.chain === ZEC_CHAIN)],
    [sourceChain, source],
  ] as const) {
    if (!open(a)) {
      throw new Error(`thorchain isn't taking ${chain.toLowerCase()} right now`);
    }
  }
  return source!;
};

/** throws a calm line for anything that would make the deposit unsafe */
export const checkQuote = (
  q: ThorQuote,
  inbound: InboundAddress[],
  sourceChain: string,
  opReturn: boolean,
  destination: string,
  nowSec = Math.floor(Date.now() / 1000),
): void => {
  const source = checkOpen(inbound, sourceChain);
  // vaults churn; a quote naming one the network no longer lists is stale
  if (q.inbound_address !== source.address) {
    throw new Error('thorchain moved its vault · please get a new quote');
  }
  if (!q.memo || (opReturn && memoBytes(q.memo) > MAX_MEMO_BYTES)) {
    throw new Error("thorchain's memo doesn't fit this chain · please try another route");
  }
  // `=:ASSET:DEST[/REFUND]:...`: the memo must pay where zafu asked, or it is not shown at all
  if (q.memo.split(':')[2]?.split('/')[0] !== destination) {
    throw new Error("thorchain's memo names another address · zafu won't show it");
  }
  if (q.expiry <= nowSec) {
    throw new Error('this quote expired · please get a new one');
  }
};

/** an amount below what thorchain swaps; `min` in the inbound asset, 1e8 */
export class BelowMinimum extends Error {
  constructor(
    readonly min: bigint,
    unit: string,
  ) {
    super(`thorchain swaps ${fromUnits(min, THOR_DECIMALS)} ${unit} or more`);
  }
}

/**
 * The quote's recommended minimum is what keeps a refund paying for itself
 * (it covers both chains' outbound fees with headroom); below it, or at the
 * source chain's dust, the deposit is not worth sending.
 */
export const checkMinimum = (
  q: ThorQuote,
  source: InboundAddress,
  amountIn: bigint,
  unit: string,
): void => {
  const dust = BigInt(q.dust_threshold ?? source.dust_threshold ?? 0);
  const min = BigInt(q.recommended_min_amount_in ?? 0);
  if (amountIn < min || amountIn <= dust) {
    throw new BelowMinimum(min > dust ? min : dust + 1n, unit);
  }
};

/**
 * A from-zec memo too long for the OP_RETURN may name the destination by its
 * THORName instead, which THORChain resolves to the target chain's alias when
 * it pays. Only then: an address pins what the user reviewed, while a name
 * pays wherever its owner points it by the time the swap runs.
 */
export const nameInMemo = (memo: string, address: string, name?: string): string => {
  const parts = memo.split(':');
  if (!name || parts[2] !== address || memoBytes(memo) <= MAX_MEMO_BYTES) {
    return memo;
  }
  parts[2] = name;
  return parts.join(':');
};

/** inbound fee = txSize * gasRate (thorchain docs, Fees), per `gas_rate_units` */
const GAS: Record<string, { size: bigint; to1e8: bigint; unit: string }> = {
  satsperbyte: { size: 250n, to1e8: 1n, unit: 'sat/byte' },
  uatom: { size: 1n, to1e8: 100n, unit: 'uatom' },
  drop: { size: 1n, to1e8: 100n, unit: 'drops' },
};

/** the source chain fee the payer sets in their own wallet, 1e8; undefined when unknown */
export const inboundFee = (q: ThorQuote): bigint | undefined => {
  const g = GAS[q.gas_rate_units ?? ''];
  return g && q.recommended_gas_rate
    ? BigInt(q.recommended_gas_rate) * g.size * g.to1e8
    : undefined;
};

/**
 * What a thorchain swap costs, from the quote: the inbound fee the payer sets
 * on the source chain (the only computed part: txSize x gasRate), thorchain's
 * own liquidity and outbound fees, and zafu's (none: no affiliate is sent).
 * Shares are of what is paid; values are in the destination asset.
 */
export const thorCost = (
  q: ThorQuote,
  into: boolean,
  inUnit: string,
  amountIn: bigint,
  outDecimals: number,
): Cost => {
  const out = (x: bigint) => rescale(x, THOR_DECIMALS, outDecimals);
  const expected = BigInt(q.expected_amount_out);
  const routeOut = BigInt(q.fees.liquidity ?? 0) + BigInt(q.fees.outbound ?? 0);
  const gross = expected + BigInt(q.fees.total);
  const inbound = into ? inboundFee(q) : undefined;
  const share = (x: bigint, of: bigint) => (of ? Number((x * 10_000n) / of) : 0);
  return costOf([
    ...(inbound !== undefined && amountIn
      ? [
          {
            label: 'network fee in',
            bps: share(inbound, amountIn),
            out: out((inbound * expected) / amountIn),
            inText: `~${fromUnits(inbound, THOR_DECIMALS)} ${inUnit}`,
          },
        ]
      : []),
    { label: 'thorchain', bps: q.fees.total_bps ?? share(routeOut, gross), out: out(routeOut) },
    { label: 'zafu fee', bps: 0, out: 0n, zafu: true },
  ]);
};

export const thorProvider: SwapProvider = {
  id: 'thor',
  tokens: () =>
    Promise.resolve(
      Object.entries(THOR_ASSETS).map(([key, a]) => {
        const [symbol = '', chain = ''] = key.split('@');
        return { symbol: symbol.toUpperCase(), chain, decimals: a.decimals };
      }),
    ),

  quote: async req => {
    const pair = {
      direction: req.direction,
      symbol: req.token.symbol.toLowerCase(),
      chain: req.token.chain,
    };
    const refusal = ROUTES.thor.refuses(pair);
    const pool = thorAsset(pair);
    if (refusal || !pool) {
      throw new Error(refusal);
    }
    const into = req.direction === 'into_zec';
    if (into && !req.zcashTransparent) {
      throw new Error('thorchain pays transparent addresses, and this wallet has none');
    }
    const amount = toUnits(req.amountIn, THOR_DECIMALS);
    const destination = into ? req.zcashTransparent! : req.otherAddress;
    const query = new URLSearchParams({
      from_asset: into ? pool.asset : ZEC_ASSET,
      to_asset: into ? ZEC_ASSET : pool.asset,
      amount: amount.toString(),
      destination,
      streaming_interval: '1',
    });
    if (into) {
      query.set('refund_address', req.otherAddress);
    }
    const sourceChain = (into ? pool.asset : ZEC_ASSET).split('.')[0]!;
    const quoted = thorFetch<ThorQuote>(`/thorchain/quote/swap?${query}`);
    quoted.catch(() => {});
    // a halted chain is said plainly, before whatever the quote makes of it
    const inbound = await thorFetch<InboundAddress[]>('/thorchain/inbound_addresses');
    const source = checkOpen(inbound, sourceChain);
    const q = await quoted;
    // a name stands in only for the destination: thorchain never resolves a refund name
    const memo = into ? q.memo : nameInMemo(q.memo, destination, req.otherName);
    checkQuote(
      { ...q, memo },
      inbound,
      sourceChain,
      !into || pool.carrier === 'op_return',
      memo === q.memo ? destination : req.otherName!,
    );
    const inUnit = into ? pair.symbol : 'zec';
    checkMinimum(q, source, amount, inUnit);
    const outDecimals = into ? 8 : pool.decimals;
    const amountOut = rescale(BigInt(q.expected_amount_out), THOR_DECIMALS, outDecimals);
    const gas = GAS[q.gas_rate_units ?? ''];
    return {
      route: 'thor',
      amountOut,
      amountOutText: fromUnits(amountOut, outDecimals),
      amountInText: fromUnits(amount, THOR_DECIMALS),
      cost: thorCost(q, into, inUnit, amount, outDecimals),
      // a streamed swap can stop part way, and thorchain sends the rest back
      refundLine:
        (q.max_streaming_quantity ?? 1) > 1 && source.outbound_fee
          ? `if refunded, thorchain keeps ${fromUnits(BigInt(source.outbound_fee), THOR_DECIMALS)} ${inUnit} to send it back`
          : undefined,
      gasLine:
        into && q.recommended_gas_rate
          ? `use a fast fee · ${q.recommended_gas_rate} ${gas?.unit ?? q.gas_rate_units ?? ''}`.trim()
          : undefined,
      timeText: q.total_swap_seconds
        ? `~${Math.max(1, Math.round(q.total_swap_seconds / 60))} min`
        : undefined,
      expiresAt: q.expiry * 1000,
      depositAddress: q.inbound_address,
      memo,
      recipient: destination,
      // sending zec in is a t->t transaction with an OP_RETURN output
      notYet: into || req.signsOpReturn ? undefined : 'not available yet',
      watch: into ? undefined : 'txid',
      raw: q,
    } satisfies Quote;
  },

  status: async (_quote, txid) => {
    try {
      return thorStatus(
        await thorFetch<ThorTxStatus>(`/thorchain/tx/status/${txid?.toUpperCase()}`),
      );
    } catch (e) {
      // thornode answers 4xx for a tx it hasn't observed yet
      if (e instanceof ThornodeRefusal) {
        return STATUS.unseen;
      }
      throw e;
    }
  },
};
