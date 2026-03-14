import type { SimpleFilter } from '../types';

/** Log service call timing and errors. */
export const logging = <Req, Rep>(label: string): SimpleFilter<Req, Rep> =>
  async (req, service) => {
    const t0 = performance.now();
    try {
      const rep = await service(req);
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      console.log(`[${label}] ${elapsed}s`);
      return rep;
    } catch (e) {
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      console.error(`[${label}] failed after ${elapsed}s:`, e);
      throw e;
    }
  };
