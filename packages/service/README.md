# @zafu/service

The services pattern, shared. Zero dependencies, no environment assumptions
(node, worker, page all fine).

This is the pattern `docs/services-pattern.md` describes, borrowed from Marius
Eriksen's _"Your Server as a Function"_ (Twitter, 2013):

```ts
type Service<Req, Res> = (req: Req, ctx: Ctx) => Promise<Res>;
type Filter<Req, Res> = (inner: Service<Req, Res>) => Service<Req, Res>;
```

A **service** is a request-to-response function. A **filter** transforms one
service into another and knows nothing about what the service does. A
**strategy** is a named, pre-composed stack of filters around a base service,
and it - not the filters - is what callers see.

## Why it exists as a package

`apps/extension` already builds its runtime this way: `services/memo-sync`,
`services/mempool-watch`, and `signing/external-signer.ts` each define their own
`XxxFetcher` / `XxxFilter` / `compose(...)`. Those are the same three types,
re-declared per module. Meanwhile the published SDK packages (`@zafu/pq`,
`@zafu/zid`, `@zafu/media`) inject transports the same way but had no shared
vocabulary for it, so every seam grew its own wrapper.

This package is that vocabulary in one place, so a service written for the
wallet runtime and a service written for the SDK compose with the same
`compose(...)` and can be tested the same way.

## Usage

```ts
import { compose, retry, timeout, trace, detachedContext } from '@zafu/service';

// the base service: the only I/O leaf, it does one thing
const wallet: Service<WalletRequest, WalletResponse> = (req, ctx) =>
  transport.request(req, ctx.signal);

// a strategy: named, pre-composed, in application order (first = outermost)
const walletStrategy = (name: 'default' | 'patient') =>
  name === 'patient'
    ? compose(trace({ onComplete: log }), timeout(30_000), retry({ attempts: 5, backoffMs: 250 }))
    : compose(trace({ onComplete: log }), timeout(10_000), retry({ attempts: 3 }));

const call = walletStrategy('default')(wallet);
await call({ type: 'sign', challenge: 'ab' }, detachedContext);
```

Cancellation is the context's `AbortSignal`: `timeout` aborts the signal it
passes downstream, so a service that can cancel (fetch, a socket read) stops
working instead of leaving a result nobody will read. It is advisory, exactly
like Finagle's interrupts - aborting never changes the returned promise, it
tells the producer the result is unwanted.

```ts
const ctrl = new AbortController();
const call = svc(req, { signal: ctrl.signal });
ctrl.abort(); // and, with timeout() in the stack, the pending call is released
```

## What is here

| Export                                           | Purpose                                                                                                                                            |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Service`, `Filter`, `ServiceContext`            | the pattern's types; `Ctx` is a per-service context type carrying `signal` and whatever that service needs                                         |
| `ServiceFilter`                                  | a filter polymorphic over request/response/context: what the built-ins below return, so `compose(timeout(ms))(anyService)` infers from the service |
| `StreamService`, `StreamFilter`                  | the streaming half of the pattern (`AsyncIterable<Res>`), kept separate so a filter never has to branch on which form it got                       |
| `compose(...filters)`                            | left-to-right: `compose(a, b)(base) === a(b(base))`, first listed is outermost                                                                     |
| `composeStream<Req, Ev>(...filters)`             | the same for streams, with the types named at the call site (a stream filter usually does arithmetic on the event type)                            |
| `identityFilter`, `detachedContext`              | no-op filter, and a frozen context for callers with nothing to cancel                                                                              |
| `timeout(ms)`                                    | deadline that also interrupts the inner service                                                                                                    |
| `retry({ attempts, backoffMs, retryOn, sleep })` | re-issues; stops on success, last attempt, a refused failure, or a caller abort                                                                    |
| `trace({ onComplete, now })`                     | duration + outcome, without changing the call                                                                                                      |
| `gate(isEnabled, onDisabled?)`                   | feature-flag / "not configured" refusal as a filter                                                                                                |
| `TimeoutError`, `UnavailableError`               | typed refusals, no prose parsing                                                                                                                   |
| `select(promises)`, `rescue(promise, handler)`   | first-to-settle, and recovery from a rejection                                                                                                     |

There is deliberately no `collect` or `flatMap`: `Promise.all` and `await` are
those. A wrapper that only renames a builtin costs the reader a jump.

## Rules that come with the pattern

1. **Filters compose by `(Service) => Service` and never mutate request or
   response shapes.** Metadata a filter needs (concurrency hint, RNG seed,
   deadline) is threaded through the context type - `declare module` augmentation
   when several modules share it, exactly as `services/memo-sync/filters/
concurrency.ts` does.
2. **The base service is the only I/O leaf.** Filters never call the network.
   That is what lets a cache short-circuit, a decoy expand, a retry re-issue and
   a timeout abandon without any of them knowing the transport.
3. **Expose strategies, keep filters internal.** Callers bind to
   `strategy('default' | 'patient')`, not to seven filters they can reorder into
   combinations nobody tested.

## Composition order

`compose` is the **first-listed filter is outermost** convention, matching
`apps/extension/src/signing/external-signer.ts`. Note that
`services/memo-sync/strategy.ts` reads its own local helper the other way
(`compose(base, [A, B, C]) === C(B(A(base)))`, "innermost first"); that helper is
private to that module, and the shared package does not follow it.

## License

MIT
