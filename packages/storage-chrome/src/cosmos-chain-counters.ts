/**
 * Burner-address rotation state for the cosmos-side unshield path.
 *
 * The two primitives here back the `zafu_get_fresh_chain_address` provider
 * method (see @zafu/protocol) and the veil / penumbra.fi unshield flow:
 *
 *   - `nextHdIndex(chainId)` atomically allocates the next BIP44 address_index
 *     for a given chain. Every unshield that lands on Injective / Osmosis /
 *     Noble / … should derive its destination at a fresh index so an observer
 *     of the transparent chain cannot group exits by receiver.
 *
 *   - `checkAndBumpFreshAddressRateLimit(origin, chainId)` enforces a per-
 *     origin, per-chain sliding-window cap so a hostile dapp cannot pump the
 *     counter into the millions (a UX bomb: the user's next legitimate
 *     unshield would derive at an insanely deep index, and the wallet would
 *     have to scan that far to see the balance).
 *
 * Both operations run inside `navigator.locks.request(..., 'exclusive')` so
 * two concurrent calls from the same origin get different indices - the
 * default chrome.storage.local API is not read-modify-write atomic on its own,
 * so without the lock a burst of getFreshChainAddress requests could collide.
 */

import { localExtStorage } from './local';

/** Namespaced lock name so we don't collide with other subsystem locks. */
const LOCK_NAME = () => `${chrome.runtime.id}.cosmos-chain-counters`;

const RATE_LIMIT_KEY = (origin: string, chainId: string): string => `${origin}|${chainId}`;

/** how many fresh derivations one origin+chain gets per 24 h. */
export const FRESH_ADDRESS_RATE_LIMIT_MAX = 100;
/** window size in ms. */
export const FRESH_ADDRESS_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Read (without allocating) the current counter value for a chain. Callers
 * should generally use `nextHdIndex` instead; this exists for the UI / tests.
 */
export const peekHdIndex = async (chainId: string): Promise<number> => {
  const map = (await localExtStorage.get('cosmosChainCounters')) ?? {};
  return map[chainId] ?? 0;
};

/**
 * Atomically read + increment the per-chain counter, returning the value that
 * was JUST allocated (post-increment, so first call returns 1, then 2, etc).
 *
 * The lock is held across the read/write so two concurrent callers see
 * different values - the storage API on its own is not read-modify-write
 * atomic across independent calls. `navigator.locks` is shared by every
 * extension realm (SW, popup, options), so this is safe cross-realm too.
 */
export const nextHdIndex = async (chainId: string): Promise<number> =>
  navigator.locks.request(LOCK_NAME(), { mode: 'exclusive' }, async () => {
    const current = (await localExtStorage.get('cosmosChainCounters')) ?? {};
    const next = (current[chainId] ?? 0) + 1;
    const updated: Record<string, number> = { ...current, [chainId]: next };
    await localExtStorage.set('cosmosChainCounters', updated);
    return next;
  });

/**
 * Reset the counter for a chain. Not exposed to dapps - only invoked by an
 * explicit user action (e.g. "recover receive addresses" in settings).
 */
export const resetHdIndex = async (chainId: string): Promise<void> =>
  navigator.locks.request(LOCK_NAME(), { mode: 'exclusive' }, async () => {
    const current = (await localExtStorage.get('cosmosChainCounters')) ?? {};
    const updated = Object.fromEntries(Object.entries(current).filter(([k]) => k !== chainId));
    await localExtStorage.set('cosmosChainCounters', updated);
  });

/**
 * Sliding-window rate-limit check + bump. Returns `{ ok: true, remaining }`
 * when the caller is under the cap (and the count is incremented in the same
 * critical section as the check), or `{ ok: false, retryAfterMs }` when the
 * cap has been reached (nothing is written; the caller is expected to refuse
 * the request with a `rate_limited` code).
 *
 * A `now` argument is accepted so tests can drive the clock without stubbing
 * globals; production callers pass nothing and get `Date.now()`.
 */
export type RateLimitCheck =
  | { ok: true; remaining: number; windowStart: number }
  | { ok: false; retryAfterMs: number };

export const checkAndBumpFreshAddressRateLimit = async (
  origin: string,
  chainId: string,
  now: number = Date.now(),
): Promise<RateLimitCheck> =>
  navigator.locks.request(LOCK_NAME(), { mode: 'exclusive' }, async () => {
    const map = (await localExtStorage.get('cosmosFreshAddressRateLimits')) ?? {};
    const key = RATE_LIMIT_KEY(origin, chainId);
    const entry = map[key];

    // Fresh window: no entry, or the existing one has aged out.
    if (!entry || now - entry.windowStart >= FRESH_ADDRESS_RATE_LIMIT_WINDOW_MS) {
      const updated = { ...map, [key]: { count: 1, windowStart: now } };
      await localExtStorage.set('cosmosFreshAddressRateLimits', updated);
      return { ok: true, remaining: FRESH_ADDRESS_RATE_LIMIT_MAX - 1, windowStart: now };
    }

    // Existing window: has capacity?
    if (entry.count >= FRESH_ADDRESS_RATE_LIMIT_MAX) {
      const retryAfterMs = Math.max(
        0,
        FRESH_ADDRESS_RATE_LIMIT_WINDOW_MS - (now - entry.windowStart),
      );
      return { ok: false, retryAfterMs };
    }

    const count = entry.count + 1;
    const updated = {
      ...map,
      [key]: { count, windowStart: entry.windowStart },
    };
    await localExtStorage.set('cosmosFreshAddressRateLimits', updated);
    return {
      ok: true,
      remaining: FRESH_ADDRESS_RATE_LIMIT_MAX - count,
      windowStart: entry.windowStart,
    };
  });
