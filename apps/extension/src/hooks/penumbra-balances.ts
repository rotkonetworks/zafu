/**
 * Single source of truth for the penumbra `['balances', account]` query.
 *
 * The home preload, the assets table, the send forms and the swap form all
 * read this one cache entry. It MUST always hold the RAW, unfiltered
 * `BalancesResponse[]`, and every consumer MUST fetch it through
 * {@link balancesQueryOptions} so it does not matter which of them runs first.
 * Per-consumer filtering / sorting goes in react-query's per-observer `select`
 * (see the selectors in `utils/is-fungible-asset.ts`), never in `queryFn`:
 * react-query serves whatever is cached under the key, so a filtering queryFn
 * silently never runs once another consumer has populated the cache.
 *
 * The queryFn deliberately does not swallow errors. Caching `[]` on failure
 * would make an unreachable view service look like an empty wallet in the
 * assets table ("no assets yet"), and would poison every other consumer for
 * the stale window. `prefetchQuery` never throws, and pickers default
 * `data` to `[]`, so letting the error through is safe everywhere.
 */

import { queryOptions } from '@tanstack/react-query';
import { viewClient } from '../clients';

export const balancesQueryKey = (account: number) => ['balances', account] as const;

export const fetchBalances = (account: number) =>
  Array.fromAsync(viewClient.balances({ accountFilter: { account } }));

export const balancesQueryOptions = (account: number) =>
  queryOptions({
    queryKey: balancesQueryKey(account),
    queryFn: () => fetchBalances(account),
    // One retry, not react-query's default three with 1s/2s/4s backoff: this
    // is a full balances stream over every note (hundreds of LP NFTs on a big
    // wallet), so three retries meant 7s+ of "loading" and four expensive
    // streams whenever the view service was briefly unavailable.
    retry: 1,
  });
