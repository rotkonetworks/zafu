# memo-sync

Modular Zcash memo-fetch service. Follows the Eriksen "Your Server as a
Function" pattern: a service is a typed async function, filters are
orthogonal `(Service) => Service` transformations, and named strategies
are pre-composed filter stacks chosen by config.

## Layout

```
types.ts                     // MemoFetcher, MemoEvent, BucketRange, MemoSyncStrategy
block-range-fetcher.ts       // concrete fetcher: GetBlockTransactions per bucket
strategy.ts                  // buildStrategy('private' | 'fast', params)
filters/
  shuffle.ts                 // randomize bucket fetch order
  decoy.ts                   // mix in N× random decoy buckets
  cache.ts                   // skip / record processed buckets (IDB or memory)
  concurrency.ts             // bound parallel fetches
```

## Usage

```typescript
import { blockRangeFetcher } from './services/memo-sync/block-range-fetcher';
import { buildStrategy } from './services/memo-sync/strategy';
import { idbBucketStore } from './services/memo-sync/filters/cache';

const base = blockRangeFetcher(zidecarClient);
const store = idbBucketStore({ open: getDb });
const fetch = buildStrategy('private', { base, store });

for await (const { bucketStart, blocks } of fetch(walletId, ownedBuckets, {
  signal: abortController.signal,
  tip: chainTip,
  activation: ORCHARD_ACTIVATION_HEIGHT,
  onProgress: (done, total) => console.log(`${done}/${total}`),
})) {
  // decode memos from `blocks` using the wallet's WASM keys
}
```

## Strategies

| Strategy | Decoys | Shuffle | Concurrency | Server visibility |
|---|---|---|---|---|
| `private` (default) | 2x | yes | 4 | 3N random 100-block windows |
| `fast` | 0 | no | 8 | N exact 100-block windows |

No strategy ever calls `GetTransaction(txid)`. There is no filter that can
recover privacy after a leaked txid lookup, so the per-tx leaky path is
deliberately not exposed by this module. Callers that need it must build
their own concrete fetcher and explicitly accept the cost.

## Adding a new filter

1. New file in `filters/`. Export `withYourFilter(opts): MemoFilter`.
2. Filter signature: `(inner: MemoFetcher) => MemoFetcher`.
3. Pass `walletId`, `ownedBuckets`, `ctx` through. Apply your transform.
4. Write a unit test against a recording mock (see `filters/*.test.ts`).
5. If the filter should be part of a public strategy, add it to
   `strategy.ts` and document the privacy effect.

## Adding a new strategy

Strategies are a closed enum (`MemoSyncStrategy` in `types.ts`). Adding a
new name requires updating both `types.ts` and `strategy.ts`. The UI
exposes only this enum, so internal composition can change without
breaking the public API.

## Design notes

- **Filter composition order**: `compose(base, [A, B, C])` produces
  `C(B(A(base)))`. At call time, C runs first (outermost), and base last
  (innermost). Read the array as "innermost first."
- **Cache vs decoy ordering**: `[cache, decoy, shuffle, concurrency]`
  means at call-time the call goes `concurrency → shuffle → decoy →
  cache → base`. Decoy adds random buckets, cache strips known ones
  (real or decoy that collided with cached real). Collisions degrade the
  3N count slightly but never re-fetch a bucket the server has already
  seen.
- **Why an async iterable**: lets the consumer process buckets as they
  arrive (display progress, persist memos incrementally) without
  buffering the whole batch in memory.
