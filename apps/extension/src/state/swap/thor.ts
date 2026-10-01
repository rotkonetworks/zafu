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
  type Quote,
  type SwapProvider,
  type SwapStatusView,
} from './provider';
import { ROUTES, THOR_ASSETS, thorAsset } from './routes';

export const ZEC_ASSET = 'ZEC.ZEC';
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
}

export interface ThorQuote {
  inbound_address: string;
  /** unix seconds */
  expiry: number;
  memo: string;
  expected_amount_out: string;
  recommended_min_amount_in?: string;
  dust_threshold?: string;
  total_swap_seconds?: number;
  router?: string;
  fees: { asset: string; total: string; total_bps?: number };
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

/** throws a calm line for anything that would make the deposit unsafe */
export const checkQuote = (
  q: ThorQuote,
  inbound: InboundAddress[],
  sourceChain: string,
  amountIn: bigint,
  opReturn: boolean,
  destination: string,
  nowSec = Math.floor(Date.now() / 1000),
): void => {
  if (!open(inbound.find(a => a.chain === 'ZEC'))) {
    throw new Error("zec isn't open on thorchain right now");
  }
  const source = inbound.find(a => a.chain === sourceChain);
  if (!open(source)) {
    throw new Error(`thorchain has paused ${sourceChain.toLowerCase()} for now`);
  }
  // vaults churn; a quote naming one the network no longer lists is stale
  if (q.inbound_address !== source?.address) {
    throw new Error('thorchain moved its vault · please get a new quote');
  }
  if (!q.memo || (opReturn && memoBytes(q.memo) > MAX_MEMO_BYTES)) {
    throw new Error("thorchain's memo doesn't fit this chain · please try another route");
  }
  // `=:ASSET:DEST:...`: the memo must pay where zafu asked, or it is not shown at all
  if (q.memo.split(':')[2] !== destination) {
    throw new Error("thorchain's memo names another address · zafu won't show it");
  }
  if (q.expiry <= nowSec) {
    throw new Error('this quote expired · please get a new one');
  }
  const min = BigInt(q.recommended_min_amount_in ?? q.dust_threshold ?? source.dust_threshold ?? 0);
  if (amountIn <= min) {
    throw new Error('this amount is below what thorchain swaps');
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

const percent = (bps: number) => `fee ${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

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
    const [q, inbound] = await Promise.all([
      thorFetch<ThorQuote>(`/thorchain/quote/swap?${query}`),
      thorFetch<InboundAddress[]>('/thorchain/inbound_addresses'),
    ]);
    const sourceChain = (into ? pool.asset : ZEC_ASSET).split('.')[0]!;
    // a name stands in only for the destination: thorchain never resolves a refund name
    const memo = into ? q.memo : nameInMemo(q.memo, destination, req.otherName);
    checkQuote(
      { ...q, memo },
      inbound,
      sourceChain,
      amount,
      !into || pool.carrier === 'op_return',
      memo === q.memo ? destination : req.otherName!,
    );
    const outDecimals = into ? 8 : pool.decimals;
    const amountOut = rescale(BigInt(q.expected_amount_out), THOR_DECIMALS, outDecimals);
    return {
      route: 'thor',
      amountOut,
      amountOutText: fromUnits(amountOut, outDecimals),
      amountInText: fromUnits(amount, THOR_DECIMALS),
      feeText: q.fees.total_bps !== undefined ? percent(q.fees.total_bps) : undefined,
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
