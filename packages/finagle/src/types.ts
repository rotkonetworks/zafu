/**
 * Core abstractions from "Your Server as a Function" (Eriksen, 2013).
 *
 * Service — an async function representing a system boundary.
 * Filter  — composable middleware that wraps a service.
 *
 * Services are symmetric: the same type represents both clients and servers.
 * Filters are orthogonal: timeout, retry, logging compose independently.
 */

/** A service is an async function from request to response. */
export type Service<Req, Rep> = (req: Req) => Promise<Rep>;

/**
 * A filter intercepts a service call. It receives the request and the
 * downstream service, and returns a (possibly transformed) response.
 *
 * Filters compose via `andThen` and `stack`.
 */
export type Filter<ReqIn, RepOut, ReqOut = ReqIn, RepIn = RepOut> = (
  req: ReqIn,
  service: Service<ReqOut, RepIn>,
) => Promise<RepOut>;

/** Simple filter where request/response types are unchanged. */
export type SimpleFilter<Req, Rep> = Filter<Req, Rep, Req, Rep>;

/**
 * A service factory creates a service, potentially with initialization.
 * Used for services that need WASM loading, worker spawning, etc.
 */
export type ServiceFactory<Req, Rep> = () => Promise<Service<Req, Rep>>;

/**
 * A streaming service emits intermediate progress values before completing.
 * Used for sync loops and progress-emitting operations.
 */
export type StreamingService<Req, Progress, Rep> = (
  req: Req,
  emit: (progress: Progress) => void,
) => Promise<Rep>;

/** Apply a simple filter to a service, producing a new service. */
export function andThen<Req, Rep>(
  filter: SimpleFilter<Req, Rep>,
  service: Service<Req, Rep>,
): Service<Req, Rep> {
  return (req: Req) => filter(req, service);
}

/**
 * Apply a transforming filter to a service.
 * The filter can change request/response types:
 *   Filter<HttpReq, HttpRep, AuthReq, AuthRep> + Service<AuthReq, AuthRep>
 *   => Service<HttpReq, HttpRep>
 */
export function andThenT<ReqIn, RepOut, ReqOut, RepIn>(
  filter: Filter<ReqIn, RepOut, ReqOut, RepIn>,
  service: Service<ReqOut, RepIn>,
): Service<ReqIn, RepOut> {
  return (req: ReqIn) => filter(req, service);
}

/**
 * Compose multiple simple filters left-to-right into one filter.
 * stack(a, b, c) means: a wraps b wraps c wraps the final service.
 */
export function stack<Req, Rep>(
  ...filters: SimpleFilter<Req, Rep>[]
): SimpleFilter<Req, Rep> {
  return (req: Req, service: Service<Req, Rep>) => {
    const composed = filters.reduceRight<Service<Req, Rep>>(
      (svc, f) => andThen(f, svc),
      service,
    );
    return composed(req);
  };
}

/** Sentinel error types for filter communication. */
export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export class CancelledError extends Error {
  constructor(reason?: string) {
    super(reason ?? 'cancelled');
    this.name = 'CancelledError';
  }
}
