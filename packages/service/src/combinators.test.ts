import { describe, expect, it } from 'vitest';

import { rescue, select } from './combinators';

/** a promise that never settles: the deterministic stand-in for "slower than the winner". */
const pending = <T>(): Promise<T> => Promise.withResolvers<T>().promise;

describe('select', () => {
  it('resolves with the first promise to settle', async () => {
    await expect(select([pending<string>(), Promise.resolve('fast')])).resolves.toBe('fast');
  });

  it('rejects when the first settled promise fails, without waiting for the others', async () => {
    const boom = new Error('first out');
    await expect(select([Promise.reject(boom), pending<string>()])).rejects.toBe(boom);
  });

  it('refuses an empty input rather than hanging forever', async () => {
    await expect(select([])).rejects.toThrow('select: no promises given');
  });
});

describe('rescue', () => {
  it('returns the value when nothing failed', async () => {
    await expect(rescue(Promise.resolve('ok'), () => 'recovered')).resolves.toBe('ok');
  });

  it('recovers a failure through the handler', async () => {
    const recovered = rescue(Promise.reject(new Error('relay down')), () => 'from cache');
    await expect(recovered).resolves.toBe('from cache');
  });

  it('lets the handler rethrow what it does not recognise', async () => {
    const unknown = new Error('unknown failure');
    const rethrown = rescue(Promise.reject(unknown), error => {
      throw error;
    });

    await expect(rethrown).rejects.toBe(unknown);
  });
});
