import type { SimpleFilter } from '../types';

/**
 * Ensure an async initialization runs (exactly once) before the service.
 * Idempotent — subsequent calls await the same promise.
 */
export const ensureInit = <Req, Rep>(
  initFn: () => Promise<void>,
): SimpleFilter<Req, Rep> => {
  let initPromise: Promise<void> | null = null;
  return async (req, service) => {
    if (!initPromise) initPromise = initFn();
    await initPromise;
    return service(req);
  };
};
