import type { SimpleFilter } from '../types';
import { TimeoutError } from '../types';

/** Fail the service call if it doesn't complete within `ms` milliseconds. */
export const timeout = <Req, Rep>(ms: number): SimpleFilter<Req, Rep> =>
  (req, service) => {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      service(req),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  };
