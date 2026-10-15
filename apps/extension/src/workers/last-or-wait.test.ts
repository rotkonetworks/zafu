import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastOrWait } from './last-or-wait';

const later = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

describe('lastOrWait', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('answers with a quick run', async () => {
    const get = lastOrWait<number>(3000, () => undefined);
    await expect(get('w', async () => 7)).resolves.toBe(7);
  });

  it('stops waiting for a slow run, and the next caller gets what it found', async () => {
    const get = lastOrWait<number>(3000, () => undefined);
    const slow = later<number>();
    const run = vi.fn(() => slow.promise);
    const first = get('w', run);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(first).resolves.toBeUndefined();
    // still running: a second caller joins it instead of asking again
    const second = get('w', run);
    slow.resolve(9);
    await expect(second).resolves.toBe(9);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('asks once per key: a later caller gets the answer without asking again', async () => {
    const get = lastOrWait<number>(3000, () => undefined);
    const run = vi.fn(async () => 1);
    await get('w@1', run);
    await expect(get('w@1', run)).resolves.toBe(1);
    expect(run).toHaveBeenCalledOnce();
  });

  it('asks again after a failed run, and says so', async () => {
    const onError = vi.fn();
    const get = lastOrWait<number>(3000, onError);
    await expect(
      get('w@1', async () => {
        throw new Error('nym down');
      }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
    await expect(get('w@1', async () => 2)).resolves.toBe(2);
  });

  it('keeps each key apart: a new check is a new key', async () => {
    const get = lastOrWait<number>(3000, () => undefined);
    await get('w@1', async () => 1);
    await expect(get('w@2', async () => 2)).resolves.toBe(2);
    await expect(get('w@1', async () => 3)).resolves.toBe(1);
  });
});
