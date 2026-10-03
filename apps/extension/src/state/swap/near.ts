/** near intents 1click as a swap route; the requests are near-swap's, unchanged */

import { zafuFeeBps } from '../../config/swap-fee';
import {
  checkSwapStatus,
  filterSwappableTokens,
  findZecAssetId,
  getSupportedTokens,
  requestQuote,
  type NearToken,
  type SwapQuoteResponse,
  type SwapStatus,
  NEAR_SLIPPAGE_BPS,
} from '../near-swap';
import { isEgressBlocked } from '../../net/egress';
import {
  costOf,
  durationText,
  figure,
  fromUnits,
  type Cost,
  type Quote,
  type QuoteRequest,
  type SwapProvider,
  type SwapStatusView,
} from './provider';
import { toUnits } from './provider';

const TOKENS_FOR_MS = 300_000;
let list: { at: number; tokens: Promise<NearToken[]> } | undefined;

/** the token list, fetched once per five minutes, refetched after a failure */
const nearTokens = (): Promise<NearToken[]> => {
  if (!list || Date.now() - list.at > TOKENS_FOR_MS) {
    const tokens = getSupportedTokens();
    list = { at: Date.now(), tokens };
    tokens.catch(() => (list = undefined));
  }
  return list.tokens;
};

/** the market's usd price of each token in 1click's list, keyed `SYMBOL@chain` */
export const nearPrices = async (): Promise<Map<string, number>> =>
  new Map(
    (await nearTokens()).flatMap(t =>
      t.price ? [[`${t.symbol}@${t.blockchain.toLowerCase()}`, t.price] as const] : [],
    ),
  );

const STATUS: Record<SwapStatus | 'none', SwapStatusView> = {
  SUCCESS: { phase: 'done', line: 'swap complete' },
  FAILED: { phase: 'failed', line: 'swap failed' },
  REFUNDED: {
    phase: 'refunded',
    line: 'near intents sent it back to your refund address · it is safe',
  },
  PROCESSING: { phase: 'processing', line: 'processing the swap' },
  KNOWN_DEPOSIT_TX: { phase: 'waiting', line: 'deposit seen, confirming' },
  INCOMPLETE_DEPOSIT: { phase: 'waiting', line: 'waiting for the full deposit' },
  PENDING_DEPOSIT: { phase: 'waiting', line: 'waiting for the deposit' },
  none: { phase: 'waiting', line: 'waiting for the deposit' },
};

/**
 * What a 1click swap costs, implied by its own prices: the value lost between
 * what is paid and what arrives, less zafu's app fee, is near's spread and
 * fees. undefined when the quote carries no prices to tell.
 */
export const nearCost = (
  amountOut: bigint,
  inUsd: number,
  outUsd: number,
  zafuBps: number,
): Cost | undefined => {
  if (!(inUsd > 0 && outUsd > 0)) {
    return undefined;
  }
  const lost = Math.max(0, 1 - outUsd / inUsd);
  const gross = Number(amountOut) / (1 - lost);
  const zafuOut = BigInt(Math.round((gross * zafuBps) / 10_000));
  const totalOut = BigInt(Math.round(gross)) - amountOut;
  return costOf([
    {
      label: 'near intents',
      bps: Math.max(0, Math.round(lost * 10_000) - zafuBps),
      out: totalOut > zafuOut ? totalOut - zafuOut : 0n,
    },
    { label: 'zafu fee', bps: zafuBps, out: zafuOut, zafu: true },
  ]);
};

/** a decimal amount in usd from base units and a unit price */
const usd = (units: string, decimals: number, price: number | null) =>
  price ? (Number(units) / 10 ** decimals) * price : 0;

export const nearProvider: SwapProvider = {
  id: 'near',
  tokens: async () =>
    filterSwappableTokens(await nearTokens()).map(t => ({
      symbol: t.symbol,
      chain: t.blockchain.toLowerCase(),
      decimals: t.decimals,
      usd: t.price ?? undefined,
    })),

  exactOut: true,

  quote: (req, signal) =>
    nearQuote(req, signal).catch((e: unknown) => {
      throw nearRefusal(e, signal);
    }),

  status: async quote => STATUS[(await checkSwapStatus(quote.depositAddress)).status ?? 'none'],
};

/** into zec with no refund address typed: near's line asks for one */
export class NeedsRefundAddress extends Error {
  constructor(chain: string) {
    super(`near intents needs your ${chain} address for refunds · tap to add it`);
  }
}

/** 1click's own words never reach the screen: a line of zafu's, or a calm stand-in */
export const nearRefusal = (e: unknown, signal?: AbortSignal): unknown => {
  const text = e instanceof Error ? e.message : '';
  return signal?.aborted || isEgressBlocked(e) || text.startsWith('near intents')
    ? e
    : new Error(
        /too low|at least|minimum/i.test(text)
          ? 'near intents needs a larger amount for this one'
          : 'near intents could not quote this right now',
      );
};

const nearQuote = async (req: QuoteRequest, signal?: AbortSignal): Promise<Quote> => {
  const all = await nearTokens();
  const zecAssetId = findZecAssetId(all);
  const token = filterSwappableTokens(all).find(
    t => t.symbol === req.token.symbol && t.blockchain.toLowerCase() === req.token.chain,
  );
  if (!zecAssetId || !token) {
    throw new Error(`near intents doesn't offer ${req.token.symbol.toLowerCase()} right now`);
  }
  const fromZec = req.direction === 'from_zec';
  // into zec, 1click refunds to the payer's own address: it can't quote without one
  if (!fromZec && !req.otherAddress) {
    throw new NeedsRefundAddress(req.token.chain);
  }
  const zafuBps = zafuFeeBps('near');
  const [inDecimals, outDecimals] = fromZec ? [8, token.decimals] : [token.decimals, 8];
  const resp: SwapQuoteResponse = await requestQuote({
    // by what arrives: 1click asks a deposit of amountIn, and sends back any excess
    swapType: req.exactOut ? 'EXACT_OUTPUT' : 'EXACT_INPUT',
    amount: (req.exactOut
      ? toUnits(req.exactOut, outDecimals)
      : toUnits(req.amountIn, inDecimals)
    ).toString(),
    slippageTolerance: NEAR_SLIPPAGE_BPS,
    originAsset: fromZec ? zecAssetId : token.assetId,
    destinationAsset: fromZec ? token.assetId : zecAssetId,
    recipient: fromZec ? req.otherAddress : req.zcashAddress,
    refundTo: fromZec ? req.zcashAddress : req.otherAddress,
    appFeeBps: zafuBps,
    dry: req.dry,
    signal,
  });
  const q = resp.quote;
  const zec = all.find(t => t.assetId === zecAssetId);
  const [from, to] = fromZec ? [zec, token] : [token, zec];
  const amountOut = BigInt(q.amountOut || '0');
  return {
    route: 'near',
    amountOut,
    amountOutText: figure(amountOut, outDecimals),
    // exact: on an exact-output quote, this is what must be deposited
    amountInText: fromUnits(BigInt(q.amountIn || '0'), inDecimals),
    atLeastText: q.minAmountOut ? figure(BigInt(q.minAmountOut), outDecimals) : undefined,
    // 1click folds every fee into the amount out; its usd figures, or the
    // listed prices, tell how much that was
    cost: nearCost(
      amountOut,
      Number(q.amountInUsd) || usd(q.amountIn, from?.decimals ?? 8, from?.price ?? null),
      Number(q.amountOutUsd) || usd(q.amountOut, to?.decimals ?? 8, to?.price ?? null),
      zafuBps,
    ),
    timeText: q.timeEstimate ? durationText(q.timeEstimate) : undefined,
    expiresAt: q.deadline ? new Date(q.deadline).getTime() : undefined,
    depositAddress: q.depositAddress,
    recipient: fromZec ? req.otherAddress : req.zcashAddress,
    watch: 'deposit',
    raw: resp,
  } satisfies Quote;
};
