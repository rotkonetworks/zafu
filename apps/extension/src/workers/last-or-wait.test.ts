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

  it('keeps the last rows when a run fails, and says so', async () => {
    const onError = vi.fn();
    const get = lastOrWait<number>(3000, onError);
    await get('w', async () => 1);
    await expect(
      get('w', async () => {
        throw new Error('nym down');
      }),
    ).resolves.toBe(1);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('keeps each key apart', async () => {
    const get = lastOrWait<number>(3000, () => undefined);
    await get('a', async () => 1);
    await expect(get('b', async () => 2)).resolves.toBe(2);
    await expect(get('a', async () => 3)).resolves.toBe(3);
  });
});
