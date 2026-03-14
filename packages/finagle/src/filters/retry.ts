import type { SimpleFilter } from '../types';

export interface RetryPolicy {
  /** Maximum number of attempts (including the first). */
  maxAttempts: number;
  /** Backoff duration in ms for attempt `i` (0-indexed). */
  backoff: (attempt: number) => number;
  /** Return true if the error is retryable. Non-retryable errors fail immediately. */
  retryable: (err: unknown) => boolean;
}

/** Exponential backoff: base * 2^attempt, capped at max. */
export const exponentialBackoff = (
  baseMs: number,
  maxMs = 30_000,
): RetryPolicy['backoff'] =>
  (attempt) => Math.min(baseMs * 2 ** attempt, maxMs);

/** Retry a service call according to the given policy. */
export const retry = <Req, Rep>(policy: RetryPolicy): SimpleFilter<Req, Rep> =>
  async (req, service) => {
    let lastErr: unknown;
    for (let i = 0; i < policy.maxAttempts; i++) {
      try {
        return await service(req);
      } catch (e) {
        lastErr = e;
        if (!policy.retryable(e)) throw e;
        if (i < policy.maxAttempts - 1) {
          await new Promise(r => setTimeout(r, policy.backoff(i)));
        }
      }
    }
    throw lastErr;
  };
