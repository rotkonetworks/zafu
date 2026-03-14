import type { SimpleFilter } from '../types';

/** Validate a field exists on the request before dispatching. */
export const requireField = <
  Req extends Record<string, unknown>,
  Rep,
>(field: string): SimpleFilter<Req, Rep> =>
  (req, service) => {
    if (!req[field]) return Promise.reject(new Error(`${field} required`));
    return service(req);
  };
