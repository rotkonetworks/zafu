/** near intents 1click as a swap route; the requests are near-swap's, unchanged */

import {
  checkSwapStatus,
  filterSwappableTokens,
  findZecAssetId,
  getSupportedTokens,
  requestQuote,
  toBaseUnits,
  type NearToken,
  type SwapQuoteResponse,
  type SwapStatus,
} from '../near-swap';
import type { Quote, SwapProvider, SwapStatusView } from './provider';

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

const STATUS: Record<SwapStatus | 'none', SwapStatusView> = {
  SUCCESS: { phase: 'done', line: 'swap complete' },
  FAILED: { phase: 'failed', line: 'swap failed' },
  REFUNDED: { phase: 'failed', line: 'swap refunded' },
  PROCESSING: { phase: 'processing', line: 'processing the swap' },
  KNOWN_DEPOSIT_TX: { phase: 'waiting', line: 'deposit seen, confirming' },
  INCOMPLETE_DEPOSIT: { phase: 'waiting', line: 'waiting for the full deposit' },
  PENDING_DEPOSIT: { phase: 'waiting', line: 'waiting for the deposit' },
  none: { phase: 'waiting', line: 'waiting for the deposit' },
};

export const nearProvider: SwapProvider = {
  id: 'near',
  tokens: async () =>
    filterSwappableTokens(await nearTokens()).map(t => ({
      symbol: t.symbol,
      chain: t.blockchain.toLowerCase(),
      decimals: t.decimals,
    })),

  quote: async req => {
    const all = await nearTokens();
    const zecAssetId = findZecAssetId(all);
    const token = filterSwappableTokens(all).find(
      t => t.symbol === req.token.symbol && t.blockchain.toLowerCase() === req.token.chain,
    );
    if (!zecAssetId || !token) {
      throw new Error(`near intents doesn't offer ${req.token.symbol.toLowerCase()} right now`);
    }
    const fromZec = req.direction === 'from_zec';
    const resp: SwapQuoteResponse = await requestQuote({
      swapType: 'EXACT_INPUT',
      amount: toBaseUnits(req.amountIn, fromZec ? 8 : token.decimals),
      originAsset: fromZec ? zecAssetId : token.assetId,
      destinationAsset: fromZec ? token.assetId : zecAssetId,
      recipient: fromZec ? req.otherAddress : req.zcashAddress,
      refundTo: fromZec ? req.zcashAddress : req.otherAddress,
    });
    const q = resp.quote;
    return {
      route: 'near',
      amountOut: BigInt(q.amountOut || '0'),
      amountOutText: q.amountOutFormatted,
      amountInText: q.amountInFormatted,
      timeText: q.timeEstimate ? `~${Math.max(1, Math.round(q.timeEstimate / 60))} min` : undefined,
      expiresAt: q.deadline ? new Date(q.deadline).getTime() : undefined,
      depositAddress: q.depositAddress,
      recipient: fromZec ? req.otherAddress : req.zcashAddress,
      raw: resp,
    } satisfies Quote;
  },

  status: async quote => STATUS[(await checkSwapStatus(quote.depositAddress)).status ?? 'none'],
};
