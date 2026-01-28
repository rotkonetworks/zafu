/**
 * smart balance caching for polkadot ecosystem
 *
 * pragmatic approach inspired by penumbra's lazy scanning:
 * - cache balances, don't query constantly
 * - track "active" vs "dormant" chains
 * - connect on-demand, disconnect after query
 * - skip dormant chains on auto-refresh
 */

import { getLightClient, CHAIN_INFO, type SupportedChain, type RelayChain } from './light-client';

/** cached balance entry */
interface CachedBalance {
  chain: SupportedChain;
  balance: bigint;
  fetchedAt: number;
  /** consecutive zero-balance fetches */
  zeroCount: number;
}

/** balance with chain info for display */
export interface ChainBalance {
  chain: SupportedChain;
  chainName: string;
  symbol: string;
  decimals: number;
  balance: bigint;
  /** true if from cache (not fresh) */
  cached: boolean;
}

/** cache configuration */
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DORMANT_THRESHOLD = 3; // mark dormant after 3 consecutive zero fetches

/** in-memory cache keyed by publicKey:chain */
const balanceCache = new Map<string, CachedBalance>();

/** chains user has explicitly enabled */
let enabledChains: Set<SupportedChain> = new Set();

/**
 * set which chains user has enabled
 *
 * called from extension when user changes settings
 */
export function setEnabledChains(chains: SupportedChain[]): void {
  enabledChains = new Set(chains);
}

/**
 * get enabled chains for a relay
 */
export function getEnabledChainsForRelay(relay: RelayChain): SupportedChain[] {
  return Array.from(enabledChains).filter(chain => {
    const info = CHAIN_INFO[chain];
    return info && (info.relay === relay || chain === relay);
  });
}

/** generate cache key */
function cacheKey(publicKey: string, chain: SupportedChain): string {
  return `${publicKey}:${chain}`;
}

/**
 * check if cached balance is still fresh
 */
function isFresh(cached: CachedBalance): boolean {
  return Date.now() - cached.fetchedAt < CACHE_TTL_MS;
}

/**
 * check if chain is dormant (likely no balance)
 */
function isDormant(cached: CachedBalance | undefined): boolean {
  return cached ? cached.zeroCount >= DORMANT_THRESHOLD : false;
}

/**
 * get balances for enabled chains - smart caching
 *
 * returns cached balances immediately, refreshes stale ones in background
 */
export async function getBalances(
  relay: RelayChain,
  publicKey: string,
  options: {
    /** force refresh even if cached */
    forceRefresh?: boolean;
    /** include dormant chains */
    includeDormant?: boolean;
  } = {}
): Promise<ChainBalance[]> {
  const chains = getEnabledChainsForRelay(relay);
  const results: ChainBalance[] = [];
  const toRefresh: SupportedChain[] = [];

  // first pass: collect cached, identify stale
  for (const chain of chains) {
    const key = cacheKey(publicKey, chain);
    const cached = balanceCache.get(key);
    const info = CHAIN_INFO[chain];

    if (cached && isFresh(cached) && !options.forceRefresh) {
      // use cached value
      if (cached.balance > 0n || options.includeDormant) {
        results.push({
          chain,
          chainName: info.name,
          symbol: info.symbol,
          decimals: info.decimals,
          balance: cached.balance,
          cached: true,
        });
      }
    } else if (!isDormant(cached) || options.forceRefresh || options.includeDormant) {
      // need to refresh (not dormant, or forced)
      toRefresh.push(chain);

      // show stale cached value while refreshing
      if (cached) {
        results.push({
          chain,
          chainName: info.name,
          symbol: info.symbol,
          decimals: info.decimals,
          balance: cached.balance,
          cached: true,
        });
      }
    }
  }

  // refresh stale chains in background (don't await for instant UX)
  if (toRefresh.length > 0) {
    void refreshChains(publicKey, toRefresh);
  }

  return results.sort((a, b) => Number(b.balance - a.balance));
}

/**
 * refresh balances for specific chains
 *
 * connects on-demand, queries, caches, returns fresh data
 */
export async function refreshChains(
  publicKey: string,
  chains: SupportedChain[]
): Promise<ChainBalance[]> {
  const results: ChainBalance[] = [];

  // fetch in parallel with error tolerance
  const fetchResults = await Promise.allSettled(
    chains.map(async (chain) => {
      const info = CHAIN_INFO[chain];
      const client = getLightClient(chain);
      const key = cacheKey(publicKey, chain);
      const existing = balanceCache.get(key);

      try {
        // connect only if needed
        if (client.state.state !== 'ready') {
          await client.connect();
        }

        // query balance
        const balance = await client.getBalance({ publicKey } as any);

        // update cache
        const newEntry: CachedBalance = {
          chain,
          balance,
          fetchedAt: Date.now(),
          zeroCount: balance === 0n ? (existing?.zeroCount ?? 0) + 1 : 0,
        };
        balanceCache.set(key, newEntry);

        return {
          chain,
          chainName: info.name,
          symbol: info.symbol,
          decimals: info.decimals,
          balance,
          cached: false,
        };
      } catch (err) {
        console.warn(`[balance-cache] failed to fetch ${chain}:`, err);

        // return cached or zero
        return {
          chain,
          chainName: info.name,
          symbol: info.symbol,
          decimals: info.decimals,
          balance: existing?.balance ?? 0n,
          cached: true,
        };
      }
    })
  );

  for (const result of fetchResults) {
    if (result.status === 'fulfilled') {
      results.push(result.value);
    }
  }

  return results.sort((a, b) => Number(b.balance - a.balance));
}

/**
 * refresh single chain balance
 */
export async function refreshChain(
  publicKey: string,
  chain: SupportedChain
): Promise<ChainBalance> {
  const [result] = await refreshChains(publicKey, [chain]);
  return result!;
}

/**
 * get cached balance without network request
 */
export function getCachedBalance(
  publicKey: string,
  chain: SupportedChain
): ChainBalance | null {
  const key = cacheKey(publicKey, chain);
  const cached = balanceCache.get(key);

  if (!cached) return null;

  const info = CHAIN_INFO[chain];
  return {
    chain,
    chainName: info.name,
    symbol: info.symbol,
    decimals: info.decimals,
    balance: cached.balance,
    cached: true,
  };
}

/**
 * clear cache (for logout/wallet switch)
 */
export function clearCache(): void {
  balanceCache.clear();
}

/**
 * mark chain as active (user sent/received on it)
 *
 * resets dormant counter so it gets queried again
 */
export function markChainActive(publicKey: string, chain: SupportedChain): void {
  const key = cacheKey(publicKey, chain);
  const cached = balanceCache.get(key);
  if (cached) {
    cached.zeroCount = 0;
  }
}

/**
 * get non-zero balances only (for display)
 */
export async function getNonZeroBalances(
  relay: RelayChain,
  publicKey: string
): Promise<ChainBalance[]> {
  const all = await getBalances(relay, publicKey);
  return all.filter(b => b.balance > 0n);
}
