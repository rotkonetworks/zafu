/**
 * A THORNode-protocol chain (THORChain, MAYAChain) as a swap route. Both speak
 * the same quote, inbound, memo and status shapes under their own path
 * prefix, so each is one config for `nodeProvider`.
 *
 * There is no deposit address per swap: the payer sends to the source chain's
 * current vault with the swap instruction as a memo, and the chain pays out
 * (or refunds) on the other side. ZEC arrives at a t-address, and ZEC sent in
 * is a t->t transaction carrying the memo in an OP_RETURN, refunded to the
 * address that funded vin[0]. Only a signer that holds the key and shows the
 * memo signs that (CAPS.opReturn); for every other wallet, from-zec quotes
 * are shown for comparison and marked not yet.
 *
 * All amounts are 1e8 fixed point, whatever the asset's decimals.
 */

import { zafuFeeBps } from '../../config/swap-fee';
import { requestEgressOptIn } from '../../net/egress-opt-in';
import { ThornodeRefusal, thornodeGet } from '../../services/thornode';
import {
  fromUnits,
  rescale,
  toUnits,
  costOf,
  durationText,
  figure,
  type Cost,
  type Quote,
  type SwapProvider,
  type SwapStatusView,
} from './provider';
import { POOLS, poolAsset, ROUTES } from './routes';

export const ZEC_ASSET = 'ZEC.ZEC';
const ZEC_CHAIN = 'ZEC';
const NODE_DECIMALS = 8;
/**
 * How far below the quoted output a swap may fill, asked of the node as
 * liquidity_tolerance_bps: the memo then carries a real price limit, and a
 * streamed sub-swap that can't meet it is refunded instead of filled at any
 * price. (tolerance_bps checks the first sub-swap against the whole limit, so
 * the node refuses every streamed swap with it.)
 */
export const PRICE_TOLERANCE_BPS = 300;
/** the most sub-swaps the node streams a swap over */
const MAX_STREAMING = 14_400n;

/** the price limit a swap memo carries (`=:ASSET:DEST:LIMIT/INTERVAL/QUANTITY:...`), 1e8; 0 when none */
export const memoLimit = (memo: string): bigint => {
  const m = /^(\d+)(?:e(\d+))?$/.exec(memo.split(':')[3]?.split('/')[0] ?? '');
  return m ? BigInt(m[1]!) * 10n ** BigInt(m[2] ?? 0) : 0n;
};

/** observers relay at most 80 bytes of OP_RETURN, and zcash allows no more */
export const MAX_MEMO_BYTES = 80;

/** a zec vault a t->t deposit can pay: base58 t1/t3, or a tex1 (ZIP 320, a P2PKH key hash) */
export const PAYABLE_ZEC_VAULT = /^(t[13][1-9A-HJ-NP-Za-km-z]{33}|tex1[02-9ac-hj-np-z]{38})$/;

/** source chains whose deposit memo rides in an OP_RETURN */
export const OP_RETURN_CHAINS = new Set(['BTC', 'LTC', 'BCH', 'DOGE', 'DASH', 'ZEC']);

export interface NodeChain {
  id: keyof typeof POOLS;
  /** the api path prefix, `/thorchain` or `/mayachain` */
  prefix: string;
  urls: string[];
  /** name the payer's refund address in the memo; else the chain refunds whoever paid */
  refundInMemo: boolean;
  /** zafu's THORName on this chain: its fee rides in the memo the quote returns */
  affiliate?: string;
}

export interface InboundAddress {
  chain: string;
  address: string;
  halted: boolean;
  /** thornode only; mayanode lists `halted` alone */
  global_trading_paused?: boolean;
  chain_trading_paused?: boolean;
  dust_threshold?: string;
  /** what the chain charges to send this chain's gas asset out (a refund, here), 1e8 */
  outbound_fee?: string;
}

/** /quote/swap; every fee is in `fees.asset`, the output asset, 1e8 */
export interface NodeQuote {
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

const nodeFetch = async <T>(chain: NodeChain, path: string, signal?: AbortSignal): Promise<T> => {
  await requestEgressOptIn(ROUTES[chain.id].egress);
  return thornodeGet<T>(`${chain.prefix}${path}`, chain.urls, signal);
};

interface NodeTxStatus {
  out_txs?: { memo?: string }[];
  stages?: {
    inbound_observed?: { completed: boolean };
    inbound_finalised?: { completed: boolean };
    swap_status?: { pending: boolean };
    swap_finalised?: { completed: boolean };
    outbound_signed?: { completed: boolean };
  };
}

/** where a deposit is, from the node's stages */
export const nodeStatus = (s: NodeTxStatus, name: string): SwapStatusView => {
  const lines = {
    unseen: { phase: 'waiting', line: `waiting for ${name} to see the deposit` },
    confirming: { phase: 'waiting', line: 'deposit seen, confirming' },
    swapping: { phase: 'processing', line: 'swapping' },
    sending: { phase: 'processing', line: 'sending to the recipient' },
    done: { phase: 'done', line: 'swap complete' },
    refunded: {
      phase: 'refunded',
      line: `${name} sent the zec back to your transparent address · it is safe`,
    },
  } as const satisfies Record<string, SwapStatusView>;
  const st = s.stages;
  const stage: keyof typeof lines = !st?.inbound_observed?.completed
    ? 'unseen'
    : !st.inbound_finalised?.completed
      ? 'confirming'
      : s.out_txs?.some(o => o.memo?.toUpperCase().startsWith('REFUND'))
        ? 'refunded'
        : st.swap_status?.pending || !st.swap_finalised?.completed
          ? 'swapping'
          : // a swap into the chain's native asset has no outbound stage
            st.outbound_signed && !st.outbound_signed.completed
            ? 'sending'
            : 'done';
  return lines[stage];
};

const memoBytes = (memo: string) => new TextEncoder().encode(memo).length;

const open = (a: InboundAddress | undefined) =>
  !!a && !a.halted && !a.global_trading_paused && !a.chain_trading_paused;

/** throws a calm line unless zec and the source chain both trade right now */
export const checkOpen = (
  name: string,
  inbound: InboundAddress[],
  sourceChain: string,
): InboundAddress => {
  const source = inbound.find(a => a.chain === sourceChain);
  for (const [chain, a] of [
    [ZEC_CHAIN, inbound.find(a => a.chain === ZEC_CHAIN)],
    [sourceChain, source],
  ] as const) {
    if (!open(a)) {
      throw new Error(`${name} isn't taking ${chain.toLowerCase()} right now`);
    }
  }
  return source!;
};

/** throws a calm line for anything that would make the deposit unsafe */
export const checkQuote = (
  name: string,
  q: NodeQuote,
  inbound: InboundAddress[],
  sourceChain: string,
  opReturn: boolean,
  destination: string,
  nowSec = Math.floor(Date.now() / 1000),
): void => {
  const source = checkOpen(name, inbound, sourceChain);
  // vaults churn; a quote naming one the network no longer lists is stale
  if (q.inbound_address !== source.address) {
    throw new Error(`${name} moved its vault · please get a new quote`);
  }
  if (!q.memo || (opReturn && memoBytes(q.memo) > MAX_MEMO_BYTES)) {
    throw new Error(`${name}'s memo doesn't fit this chain · please try another route`);
  }
  // out of zec the deposit is a t->t: a vault that isn't a base58 t-address or a
  // ZIP 320 tex address could never be paid, so it is refused before anything moves
  if (sourceChain === ZEC_CHAIN && !PAYABLE_ZEC_VAULT.test(q.inbound_address)) {
    throw new Error(`${name}'s zec vault is an address zafu can't pay · please try another route`);
  }
  // `=:ASSET:DEST[/REFUND]:...`: the memo must pay where zafu asked, or it is not shown at all
  if (q.memo.split(':')[2]?.split('/')[0] !== destination) {
    throw new Error(`${name}'s memo names another address · zafu won't show it`);
  }
  if (q.expiry <= nowSec) {
    throw new Error('this quote expired · please get a new one');
  }
  // a limit of 0 fills at any price, however thin the pool: never signed
  if (!memoLimit(q.memo)) {
    throw new Error(`${name}'s quote carries no price limit · zafu won't sign it`);
  }
};

/** an amount below what the route swaps; `min` in the inbound asset, 1e8 */
export class BelowMinimum extends Error {
  constructor(
    readonly min: bigint,
    unit: string,
    name: string,
  ) {
    super(`${name} swaps ${fromUnits(min, NODE_DECIMALS)} ${unit} or more`);
  }
}

/**
 * What the node's refusal means, said plainly. THORNode answers a pool it
 * cannot fill with "amount less than min swap amount (recommended_min_amount_in:
 * N)" even when the amount is far above N (a near-empty pool), so a minimum
 * the amount already clears is read as "cannot fill", never as "too little".
 */
const minIn = (text: string): bigint | undefined => {
  const n = /recommended_min_amount_in:\s*(\d+)/.exec(text)?.[1];
  return n === undefined ? undefined : BigInt(n);
};

export const nodeRefusal = (name: string, e: unknown, amountIn: bigint, unit: string): Error => {
  const text = e instanceof Error ? e.message : String(e);
  // the price limit can't be met: the pool is too thin to fill this fairly
  if (text.includes('less than price limit')) {
    return new Error(`${name} · its zec pool can't fill this at a fair price`);
  }
  const min = minIn(text);
  if (min !== undefined) {
    return amountIn < min
      ? new BelowMinimum(min, unit, name)
      : new Error(`${name} can't fill this right now · its pool is too small`);
  }
  return new Error(`${name} could not quote this right now`);
};

/**
 * The quote's recommended minimum is what keeps a refund paying for itself
 * (it covers both chains' outbound fees with headroom); below it, or at the
 * source chain's dust, the deposit is not worth sending.
 */
export const checkMinimum = (
  name: string,
  q: NodeQuote,
  source: InboundAddress,
  amountIn: bigint,
  unit: string,
): void => {
  const dust = BigInt(q.dust_threshold ?? source.dust_threshold ?? 0);
  const min = BigInt(q.recommended_min_amount_in ?? 0);
  if (amountIn < min || amountIn <= dust) {
    throw new BelowMinimum(min > dust ? min : dust + 1n, unit, name);
  }
};

/** inbound fee = txSize * gasRate (thorchain docs, Fees), per `gas_rate_units` */
const GAS: Record<string, { size: bigint; to1e8: bigint; unit: string }> = {
  satsperbyte: { size: 250n, to1e8: 1n, unit: 'sat/byte' },
  uatom: { size: 1n, to1e8: 100n, unit: 'uatom' },
  drop: { size: 1n, to1e8: 100n, unit: 'drops' },
};

/** the source chain fee the payer sets in their own wallet, 1e8; undefined when unknown */
export const inboundFee = (q: NodeQuote): bigint | undefined => {
  const g = GAS[q.gas_rate_units ?? ''];
  return g && q.recommended_gas_rate
    ? BigInt(q.recommended_gas_rate) * g.size * g.to1e8
    : undefined;
};

/**
 * What a swap costs, from the quote: the inbound fee the payer sets on the
 * source chain (the only computed part: txSize x gasRate), the chain's own
 * liquidity and outbound fees, and zafu's affiliate fee as the quote charged
 * it (`zafuBps` is the rate asked for; none shows when the quote took none).
 * Shares are of what is paid; values are in the destination asset.
 */
export const nodeCost = (
  name: string,
  q: NodeQuote,
  into: boolean,
  inUnit: string,
  amountIn: bigint,
  outDecimals: number,
  zafuBps = 0,
): Cost => {
  const out = (x: bigint) => rescale(x, NODE_DECIMALS, outDecimals);
  const expected = BigInt(q.expected_amount_out);
  const routeOut = BigInt(q.fees.liquidity ?? 0) + BigInt(q.fees.outbound ?? 0);
  const gross = expected + BigInt(q.fees.total);
  const inbound = into ? inboundFee(q) : undefined;
  // to the nearest bps, never truncated down, so a fee is not shown smaller than it is
  const share = (x: bigint, of: bigint) => (of ? Number((x * 20_000n + of) / (2n * of)) : 0);
  return costOf([
    ...(inbound !== undefined && amountIn
      ? [
          {
            label: 'network fee in',
            bps: share(inbound, amountIn),
            out: out((inbound * gross) / amountIn),
            inText: `~${fromUnits(inbound, NODE_DECIMALS)} ${inUnit}`,
          },
        ]
      : []),
    { label: name, bps: share(routeOut, gross), out: out(routeOut) },
    ((zafu: bigint) => ({
      label: 'zafu fee',
      bps: zafu ? zafuBps : 0,
      out: out(zafu),
      zafu: true,
    }))(BigInt(q.fees.affiliate ?? 0)),
  ]);
};

export const nodeProvider = (chain: NodeChain): SwapProvider => {
  const name = ROUTES[chain.id].label;
  return {
    id: chain.id,
    tokens: () =>
      Promise.resolve(
        Object.entries(POOLS[chain.id]).map(([key, a]) => {
          const [symbol = '', chain = ''] = key.split('@');
          return { symbol: symbol.toUpperCase(), chain, decimals: a.decimals };
        }),
      ),

    quote: async (req, signal) => {
      const pair = {
        direction: req.direction,
        symbol: req.token.symbol.toLowerCase(),
        chain: req.token.chain,
      };
      const refusal = ROUTES[chain.id].refuses(pair);
      const pool = poolAsset(chain.id, pair);
      if (refusal || !pool) {
        throw new Error(refusal);
      }
      const into = req.direction === 'into_zec';
      if (into && !req.zcashTransparent) {
        throw new Error(`${name} pays transparent addresses, and this wallet has none`);
      }
      const amount = toUnits(req.amountIn, NODE_DECIMALS);
      const destination = into ? req.zcashTransparent! : req.otherAddress;
      const query = new URLSearchParams({
        from_asset: into ? pool.asset : ZEC_ASSET,
        to_asset: into ? ZEC_ASSET : pool.asset,
        amount: amount.toString(),
        destination,
        streaming_interval: '1',
        liquidity_tolerance_bps: String(PRICE_TOLERANCE_BPS),
      });
      const sourceChain = (into ? pool.asset : ZEC_ASSET).split('.')[0]!;
      // utxo deposits carry the memo in an 80-byte OP_RETURN, where dest/refund
      // does not fit (94 bytes for btc); the network refunds those to the sender
      if (into && chain.refundInMemo && !OP_RETURN_CHAINS.has(sourceChain)) {
        query.set('refund_address', req.otherAddress);
      }
      // the affiliate rides even at 0 bps, so the volume is still zafu's THORName's
      const zafuBps = chain.affiliate ? zafuFeeBps(chain.id) : 0;
      if (chain.affiliate) {
        query.set('affiliate', chain.affiliate);
        query.set('affiliate_bps', String(zafuBps));
      }
      const unitIn = (into ? req.token.symbol : 'zec').toLowerCase();
      // the node's own words never reach the screen
      const plainly = (e: unknown) => {
        throw nodeRefusal(name, e, amount, unitIn);
      };
      const ask = () => nodeFetch<NodeQuote>(chain, `/quote/swap?${query}`, signal);
      // the node's own streaming count can cut a swap into parts below its minimum, and it
      // then refuses an amount it can fill: asked again in parts that each clear the minimum
      const quoted = ask().catch((e: unknown) => {
        const n = minIn(e instanceof Error ? e.message : '');
        if (!n || amount < n) {
          throw e;
        }
        const parts = amount / n;
        query.set('streaming_quantity', String(parts < MAX_STREAMING ? parts : MAX_STREAMING));
        return ask();
      });
      quoted.catch(() => {});
      // a halted chain is said plainly, before whatever the quote makes of it
      const inbound = await nodeFetch<InboundAddress[]>(chain, '/inbound_addresses', signal).catch(
        plainly,
      );
      const source = checkOpen(name, inbound, sourceChain);
      const q = await quoted.catch(plainly);
      checkQuote(name, q, inbound, sourceChain, !into || pool.carrier === 'op_return', destination);
      const inUnit = into ? pair.symbol : 'zec';
      checkMinimum(name, q, source, amount, inUnit);
      const outDecimals = into ? 8 : pool.decimals;
      const amountOut = rescale(BigInt(q.expected_amount_out), NODE_DECIMALS, outDecimals);
      const gas = GAS[q.gas_rate_units ?? ''];
      return {
        route: chain.id,
        amountOut,
        amountOutText: figure(amountOut, outDecimals),
        amountInText: fromUnits(amount, NODE_DECIMALS),
        cost: nodeCost(name, q, into, inUnit, amount, outDecimals, zafuBps),
        // a streamed swap can stop part way, and the chain sends the rest back
        refundLine:
          (q.max_streaming_quantity ?? 1) > 1 && source.outbound_fee
            ? `if refunded, ${name} keeps ${fromUnits(BigInt(source.outbound_fee), NODE_DECIMALS)} ${inUnit} to send it back`
            : undefined,
        gasLine:
          into && q.recommended_gas_rate
            ? `use a fast fee · ${q.recommended_gas_rate} ${gas?.unit ?? q.gas_rate_units ?? ''}`.trim()
            : undefined,
        timeText: q.total_swap_seconds ? durationText(q.total_swap_seconds) : undefined,
        atLeastText: figure(rescale(memoLimit(q.memo), NODE_DECIMALS, outDecimals), outDecimals),
        streamLine:
          (q.streaming_swap_blocks ?? 0) > 1 && (q.total_swap_seconds ?? 0) >= 3600
            ? `streams over ${durationText(q.total_swap_seconds!)} · unfilled parts come back`
            : undefined,
        expiresAt: q.expiry * 1000,
        depositAddress: q.inbound_address,
        memo: q.memo,
        recipient: destination,
        // sending zec in is a t->t transaction with an OP_RETURN output
        notYet: into || req.signsOpReturn ? undefined : 'not available yet',
        watch: into ? undefined : 'txid',
        raw: q,
      } satisfies Quote;
    },

    status: async (_quote, txid) => {
      try {
        return nodeStatus(
          await nodeFetch<NodeTxStatus>(chain, `/tx/status/${txid?.toUpperCase()}`),
          name,
        );
      } catch (e) {
        // the node answers 4xx for a tx it hasn't observed yet
        if (e instanceof ThornodeRefusal) {
          return nodeStatus({}, name);
        }
        throw e;
      }
    },
  };
};
