# Services Pattern

Zafu's wallet runtime is built around a single composable shape borrowed from
Marius Eriksen's "Your Server as a Function" (Twitter, 2013):

```
type Service<Req, Res> = (req: Req) => Promise<Res> | AsyncIterable<Res>
type Filter <Req, Res> = (service: Service<Req, Res>) => Service<Req, Res>
```

A **service** is a function from a request to a response (or a stream of
events). A **filter** is a transformation of one service into another. Filters
are orthogonal to services — they don't know what the service does, only what
its shape is. A **strategy** is a named, pre-composed stack of filters around
a base service.

The wallet exposes named strategies (e.g. `private` / `fast` / `paranoid`) as
the only public surface. Filters are internal building blocks.

## Shared implementation

Those two types ship as a package so the wallet runtime and the published SDK
packages use one definition instead of three: **`@zafu/service`**
(`packages/service`, zero dependencies). It exports `Service`, `Filter`,
`StreamService`, `StreamFilter`, `compose`, `identityFilter`, `detachedContext`,
the filters most services end up wanting (`timeout`, `retry`, `trace`, `gate`),
their typed errors (`TimeoutError`, `UnavailableError`) and the two combinators
that are not already a language call (`select`, `rescue`).

Three conventions it pins that this doc left open:

- **Composition order.** `compose(a, b)(base) === a(b(base))` — the first-listed
  filter is OUTERMOST. This matches `signing/external-signer.ts`. The local
  helper in `services/memo-sync/strategy.ts` reads its array the other way
  ("innermost first"); that helper is private to that module, and new code should
  use the shared `compose`.
- **Context threading.** The second argument is a per-service context type:
  `Service<Req, Res, Ctx>`. Cancellation (`signal`) belongs in every context via
  `ServiceContext`; knobs specific to one service family are added to that
  family's context type with `declare module` augmentation, exactly as
  `services/memo-sync/filters/concurrency.ts` does. A filter that needs a knob
  adds it to the context type — never to the request or response shape (rule 1).
- **Streaming is a separate type.** The `Promise<Res> | AsyncIterable<Res>` union
  above is spelled as two aliases, `Service` and `StreamService` (with
  `StreamFilter` alongside), so a filter never has to branch on which form it
  was handed.

There is deliberately no `collect` or `flatMap` in the package: `Promise.all` and
`await` are those, and a wrapper that only renames a builtin costs the reader a
jump to find out.

## Why this shape

- **Composition over configuration.** Adding decoy buckets, shuffling, or a
  cache is a one-line wrap, not a flag threaded through five files.
- **Privacy as filter, not as core logic.** The base fetcher just fetches.
  Privacy properties (decoys, shuffle, cache, concurrency caps) are filters
  the user can opt into.
- **Testability.** Each filter is a pure transformation around an injected
  service. Tests construct an in-memory base and assert on what the filter
  passes in and out.
- **Extensibility without churn.** A new service (e.g. zcash address-sync,
  ICE-over-memo, FROST coordination) lives in its own `services/<name>/`
  directory and follows the same shape. No worker rewrite required.

## File layout

```
apps/extension/src/services/<name>/
├── types.ts                  # Service signature, event types, constants
├── <name>-fetcher.ts         # Concrete base service (the I/O leaf)
├── strategy.ts               # buildStrategy('private' | 'fast' | …)
├── filters/
│   ├── <filter-a>.ts         # One filter per file
│   ├── <filter-a>.test.ts
│   ├── <filter-b>.ts
│   └── …
└── README.md                 # Module-level intent
```

Two rules:

1. **Filters compose by `(Service) => Service`**, never by mutating request or
   response shapes. If a filter needs metadata (concurrency hint, RNG seed),
   it threads it through the request context, declared via `declare module` so
   types remain centralized.
2. **The base service is the only I/O leaf.** Filters never call the network
   directly. This is what makes the cache filter able to short-circuit, the
   decoy filter able to expand the input set, and the shuffle filter able to
   reorder — all without coupling to transport.

## Reference: `services/memo-sync/`

The first instance of this pattern in Zafu. It powers Zcash memo discovery
with privacy-preserving bucket fetching.

- **`types.ts`** — defines `MemoFetcher` (the service), `MemoEvent` (the
  streamed response), `BucketRange`, `FetchContext`, `MemoSyncStrategy`.
- **`block-range-fetcher.ts`** — base service that calls
  `BlockRangeClient.getBlockTransactions(height)` per bucket.
- **`filters/cache.ts`** — `withBucketCache(store)` strips already-processed
  buckets from the input and records new ones after fetch.
- **`filters/decoy.ts`** — `withDecoyBuckets({ ratio })` adds N× random decoy
  buckets uniformly over `[activation, tip]`.
- **`filters/shuffle.ts`** — `withShuffle(rng)` Fisher-Yates reorders the
  input set so the server can't infer real buckets from arrival order.
- **`filters/concurrency.ts`** — `withConcurrency(n)` annotates the context
  with a concurrency hint the base honors.
- **`strategy.ts`** — `buildStrategy(name, params)` composes the above into
  closed enum strategies: `private` (2× decoy, shuffle, cache, c=4),
  `fast` (cache, c=8), `paranoid` (5× decoy, shuffle, cache, c=2).

Privacy contract: **no strategy ever calls `GetTransaction(txid)`**, because
no filter can recover privacy from a leaked txid lookup. Only the bucket-level
`GetBlockTransactions(height)` path is wrapped.

See [`zcash-memo-fetch-privacy.md`](zcash-memo-fetch-privacy.md) for the
privacy argument that motivated the design.

## Adding a new service

1. Create `services/<name>/types.ts` with the service signature. Pick a name
   that describes what it does, not how (good: `MemoFetcher`; bad:
   `MemoSyncStrategy_Internal`).
2. Implement the base in `<name>-fetcher.ts` — the dumbest possible thing
   that calls the network and emits events.
3. Add filters under `filters/` one at a time. Each filter should compile in
   isolation against the service type, with no dependency on other filters.
4. Add a `strategy.ts` that exposes a closed enum of named compositions to
   the rest of the app. The UI binds to this enum, not to the filters.
5. Wire the strategy into the worker (or wherever the service runs). The
   worker becomes a thin shell: load state, build the input, hand off to the
   composed service, decode events as they stream.

## What lives outside this pattern

- **One-off transforms.** If a piece of logic only ever has one
  implementation and no privacy/perf knobs, just inline it.
- **Synchronous data shaping.** Use a plain function.
- **State management.** Keep service modules stateless (the IndexedDB store
  is injected); long-lived state lives in Zustand slices.

The pattern earns its keep when a service has more than one knob, or when
those knobs are something the user (not the dev) chooses.
