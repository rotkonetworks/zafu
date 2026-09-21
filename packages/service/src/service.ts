/**
 * The services pattern, shared.
 *
 * `docs/services-pattern.md` states the shape this repo's runtime is built on,
 * borrowed from Marius Eriksen's "Your Server as a Function" (Twitter, 2013):
 * a Service is a request-to-response function, a Filter transforms one Service
 * into another, and a Strategy is a named stack of Filters around a base Service
 * that callers bind to.
 *
 * This package is that pattern as a zero-dependency module so ONE definition is
 * used by `apps/extension`'s service modules (memo-sync, mempool-watch, the
 * external signers) and by the published SDK packages (`@zafu/pq`, `@zafu/zid`,
 * `@zafu/media`). The alternative - each package declaring its own
 * near-identical Service type - is how a codebase ends up with three dialects
 * that do not compose.
 *
 * Two rules carried over verbatim from the pattern doc, because violating them
 * is how this style rots:
 *
 *   1. Filters compose by `(Service) => Service` and NEVER mutate request or
 *      response shapes. Metadata a filter needs is threaded through the context
 *      type (`declare module` augmentation when it must be shared).
 *   2. The base service is the only I/O leaf. Filters never call the network
 *      themselves. That is what lets a cache short-circuit, a decoy expand, a
 *      retry re-issue and a timeout abandon without any of them knowing the
 *      transport.
 *
 * Filter types are POLYMORPHIC - `ServiceFilter` is generic over the request,
 * response and context - so a filter written once (`timeout`, `retry`, `trace`)
 * applies to any service and `compose(timeout(ms))(anyService)` infers the types
 * from the service instead of forcing the caller to repeat them. `Filter<Req,
 * Res, Ctx>` is the same idea pinned to one service, for adapters that only make
 * sense against one shape.
 *
 * Cancellation: a Promise is a value, not a handle on the work behind it, so the
 * context carries an AbortSignal - the interrupt channel. `timeout` aborts the
 * signal it passes downstream and a service that can cancel is expected to
 * observe it. Advisory, exactly like Finagle's interrupts: aborting does not
 * change the returned promise, it tells the producer nobody wants the result.
 */

/** what every service is called with beyond its request. */
export interface ServiceContext {
  /** advisory cancellation ("interrupt"). */
  readonly signal?: AbortSignal;
}

/** a request-to-response function. `Ctx` carries cancellation and metadata. */
export type Service<Req, Res, Ctx extends ServiceContext = ServiceContext> = (
  req: Req,
  ctx: Ctx,
) => Promise<Res>;

/** one orthogonal concern wrapped around one service shape. */
export type Filter<Req, Res, Ctx extends ServiceContext = ServiceContext> = (
  inner: Service<Req, Res, Ctx>,
) => Service<Req, Res, Ctx>;

/**
 * One orthogonal concern wrapped around ANY service shape. This is what the
 * filters in this package return, and what `compose` accepts: the request,
 * response and context types are chosen by the service the stack is applied to.
 */
export type ServiceFilter = <Req, Res, Ctx extends ServiceContext>(
  inner: Service<Req, Res, Ctx>,
) => Service<Req, Res, Ctx>;

/**
 * A service that streams its response instead of resolving once - the other half
 * of the pattern doc's `Promise<Res> | AsyncIterable<Res>`. The wallet's
 * `MemoFetcher` and `MempoolFetcher` are these; a `Service` and a `StreamService`
 * never mix, so each gets its own filter/compose types rather than a union that
 * would force every filter to branch on which form it got.
 */
export type StreamService<Req, Ev, Ctx extends ServiceContext = ServiceContext> = (
  req: Req,
  ctx: Ctx,
) => AsyncIterable<Ev>;

/** one orthogonal concern wrapped around one stream shape. */
export type StreamFilter<Req, Ev, Ctx extends ServiceContext = ServiceContext> = (
  inner: StreamService<Req, Ev, Ctx>,
) => StreamService<Req, Ev, Ctx>;

/**
 * Compose filters onto a base service, left-to-right in application order:
 *
 *   compose(a, b)(base) === a(b(base))
 *
 * so the first-listed filter is the OUTERMOST (runs first on the way in), which
 * is the same convention `apps/extension/src/signing/external-signer.ts` uses.
 * An empty list is the identity.
 */
export function compose(...filters: readonly ServiceFilter[]): ServiceFilter {
  return <Req, Res, Ctx extends ServiceContext>(inner: Service<Req, Res, Ctx>) =>
    filters.reduceRight((next, filter) => filter(next), inner);
}

/**
 * The same for streaming services. Unlike `compose`, the types are named at the
 * call site (`composeStream<Height, MemoEvent>(...)`): a stream filter usually
 * does arithmetic or filtering on the event type, which a polymorphic filter
 * cannot express, so this form takes a concrete shape the way the extension's
 * per-service `XxxFilter` types do.
 */
export function composeStream<Req, Ev, Ctx extends ServiceContext = ServiceContext>(
  ...filters: readonly StreamFilter<Req, Ev, Ctx>[]
): StreamFilter<Req, Ev, Ctx> {
  return inner => filters.reduceRight((next, filter) => filter(next), inner);
}

/** the no-op filter: a default for conditional composition. */
export const identityFilter: ServiceFilter = inner => inner;

/**
 * A context with nothing to cancel, for callers with no lifecycle of their own.
 * Frozen so a filter cannot quietly attach state to the shared instance.
 */
export const detachedContext: ServiceContext = Object.freeze({});
