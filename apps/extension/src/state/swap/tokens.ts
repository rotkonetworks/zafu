/**
 * The picker's view of the route tokens: readable chain names, chains in a
 * useful order, and search that knows both "eth" and "ethereum". Routes list
 * one token per chain (usdc on eth, base, sol, ...), so picking is chain first,
 * and a search term may name either the coin or the chain.
 */

import type { SwapToken } from './provider';

const CHAINS: Record<string, { name: string; aliases?: string[] }> = {
  eth: { name: 'ethereum', aliases: ['mainnet', 'erc20'] },
  btc: { name: 'bitcoin' },
  sol: { name: 'solana', aliases: ['spl'] },
  near: { name: 'near', aliases: ['nep141'] },
  base: { name: 'base' },
  arb: { name: 'arbitrum' },
  op: { name: 'optimism' },
  pol: { name: 'polygon', aliases: ['matic'] },
  bsc: { name: 'bnb chain', aliases: ['bnb', 'binance', 'bep20'] },
  avax: { name: 'avalanche', aliases: ['c-chain'] },
  gnosis: { name: 'gnosis', aliases: ['xdai'] },
  gaia: { name: 'cosmos hub', aliases: ['cosmos', 'atom'] },
  aptos: { name: 'aptos' },
  sui: { name: 'sui' },
  ton: { name: 'ton' },
  tron: { name: 'tron', aliases: ['trc20'] },
  stellar: { name: 'stellar', aliases: ['xlm'] },
  xrp: { name: 'xrp ledger', aliases: ['ripple', 'xrpl'] },
  cardano: { name: 'cardano', aliases: ['ada'] },
  doge: { name: 'dogecoin' },
  ltc: { name: 'litecoin' },
  bch: { name: 'bitcoin cash' },
  dash: { name: 'dash' },
  starknet: { name: 'starknet' },
  scroll: { name: 'scroll' },
  monad: { name: 'monad' },
  bera: { name: 'berachain' },
  hypercore: { name: 'hyperliquid', aliases: ['hl'] },
  xlayer: { name: 'x layer', aliases: ['okx'] },
  hood: { name: 'robinhood chain', aliases: ['robinhood'] },
};

export const chainName = (code: string): string => CHAINS[code]?.name ?? code;

const POPULAR_SYMBOLS = ['BTC', 'ETH', 'USDC', 'USDT', 'SOL', 'NEAR'];
const POPULAR_CHAINS = ['btc', 'eth', 'sol', 'near', 'base', 'arb', 'bsc', 'op', 'pol'];

const rank = (list: string[], v: string) => {
  const i = list.indexOf(v);
  return i < 0 ? list.length : i;
};

/** chains the tokens sit on with how many each lists, popular first, then by size */
export const chainsOf = (tokens: readonly SwapToken[]): { chain: string; count: number }[] => {
  const count = new Map<string, number>();
  for (const t of tokens) {
    count.set(t.chain, (count.get(t.chain) ?? 0) + 1);
  }
  return [...count]
    .map(([chain, n]) => ({ chain, count: n }))
    .sort(
      (a, b) =>
        rank(POPULAR_CHAINS, a.chain) - rank(POPULAR_CHAINS, b.chain) ||
        b.count - a.count ||
        a.chain.localeCompare(b.chain),
    );
};

/**
 * 0 = no match, higher = better. Every word must match the coin or the chain,
 * so "usdc base" narrows to usdc on base and "eth" finds eth itself first,
 * then everything on ethereum.
 */
const score = (t: SwapToken, words: string[]): number => {
  const sym = t.symbol.toLowerCase();
  const info = CHAINS[t.chain];
  const chainWords = [t.chain, info?.name ?? '', ...(info?.aliases ?? [])];
  let total = 0;
  for (const w of words) {
    const s =
      sym === w
        ? 100
        : sym.startsWith(w)
          ? 50
          : chainWords.includes(w)
            ? 30
            : chainWords.some(c => c.startsWith(w))
              ? 20
              : sym.includes(w)
                ? 10
                : 0;
    if (!s) {
      return 0;
    }
    total += s;
  }
  return total;
};

/** the tokens to show for a search and an optional chain, best first */
export const searchTokens = (
  tokens: readonly SwapToken[],
  query: string,
  chain?: string,
): SwapToken[] => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tokens
    .filter(t => !chain || t.chain === chain)
    .map(t => ({ t, s: words.length ? score(t, words) : 1 }))
    .filter(x => x.s > 0)
    .sort(
      (a, b) =>
        b.s - a.s ||
        rank(POPULAR_SYMBOLS, a.t.symbol) - rank(POPULAR_SYMBOLS, b.t.symbol) ||
        a.t.symbol.localeCompare(b.t.symbol) ||
        rank(POPULAR_CHAINS, a.t.chain) - rank(POPULAR_CHAINS, b.t.chain),
    )
    .map(x => x.t);
};
