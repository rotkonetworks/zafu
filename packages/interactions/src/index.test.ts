import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentInteraction, interaction, interactionKey, type InteractionStatus } from '.';

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('interaction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('joins a request already in flight instead of sending a second one', async () => {
    const answer = deferred<string>();
    const run = vi.fn(() => answer.promise);

    const first = interaction('connect', run);
    const second = interaction('connect', run);

    expect(second).toBe(first);
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);

    answer.resolve('ok');
    await expect(first.result).resolves.toBe('ok');
    await expect(second.result).resolves.toBe('ok');
  });

  it('starts fresh once the previous one settled', async () => {
    const run = vi.fn(() => Promise.resolve(1));
    await interaction('k', run).result;
    await interaction('k', run).result;
    expect(run).toHaveBeenCalledTimes(2);
    expect(currentInteraction('k')).toBeUndefined();
  });

  it('turns slow instead of timing out, and still takes the late answer', async () => {
    const answer = deferred<string>();
    const seen: InteractionStatus[] = [];
    const i = interaction('slow', () => answer.promise, {
      slowAfterMs: 1000,
      onStatus: s => seen.push(s),
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(i.status).toBe('slow');

    answer.resolve('approved after a minute');
    await expect(i.result).resolves.toBe('approved after a minute');
    expect(seen).toEqual(['waiting', 'slow', 'done']);
  });

  it('reports failed and rejects with the original error', async () => {
    const err = Object.assign(new Error('declined'), { code: 'denied' });
    const seen: InteractionStatus[] = [];
    const i = interaction('fail', () => Promise.reject(err), { onStatus: s => seen.push(s) });
    await expect(i.result).rejects.toBe(err);
    expect(seen).toEqual(['waiting', 'failed']);
  });

  it('turns a synchronous throw into a rejection', async () => {
    const i = interaction('sync-throw', () => {
      throw new Error('boom');
    });
    await expect(i.result).rejects.toThrow('boom');
  });

  it("gives a joining caller's onStatus the current status and later changes", async () => {
    const answer = deferred<void>();
    interaction('join', () => answer.promise, { slowAfterMs: 10 });
    await vi.advanceTimersByTimeAsync(20);

    const seen: InteractionStatus[] = [];
    interaction('join', () => Promise.resolve(), { onStatus: s => seen.push(s) });
    answer.resolve();
    await currentInteraction('join')?.result;
    expect(seen).toEqual(['slow', 'done']);
  });

  it('keeps going when a status listener throws', async () => {
    const i = interaction('throwing-ui', () => Promise.resolve('v'), {
      onStatus: () => {
        throw new Error('ui bug');
      },
    });
    await expect(i.result).resolves.toBe('v');
  });

  it('subscribing after settle reports the final status once', async () => {
    const i = interaction('late', () => Promise.resolve());
    await i.result;
    const listener = vi.fn();
    i.subscribe(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('done');
  });
});

describe('interactionKey', () => {
  it('ignores object key order', () => {
    expect(interactionKey('m', { a: 1, b: 2 })).toBe(interactionKey('m', { b: 2, a: 1 }));
  });
  it('tells different requests apart', () => {
    expect(interactionKey('zafu_sign', { c: '01' })).not.toBe(
      interactionKey('zafu_sign', { c: '02' }),
    );
  });
  it('encodes bytes', () => {
    expect(interactionKey(new Uint8Array([1, 255]))).toBe(interactionKey(new Uint8Array([1, 255])));
    expect(interactionKey(new Uint8Array([1]))).not.toBe(interactionKey(new Uint8Array([2])));
  });
});
