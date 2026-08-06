import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { once } from './once';

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('once', () => {
  it('runs the initializer once for callers that race in the same tick', async () => {
    let runs = 0;
    const gate = deferred<void>();
    const init = once(async () => {
      runs++;
      await gate.promise;
      return 'wasm';
    });

    // exactly the shape of the bug: two messages hit `await initWasm()` before
    // the first has finished, so a plain module-set flag is still null
    const a = init();
    const b = init();
    expect(runs).toBe(1);

    gate.resolve();
    expect(await a).toBe('wasm');
    expect(await b).toBe('wasm');
    expect(runs).toBe(1);

    expect(await init()).toBe('wasm');
    expect(runs).toBe(1);
  });

  it('lets a failed initializer be retried', async () => {
    let runs = 0;
    const init = once(async () => {
      runs++;
      if (runs === 1) {
        throw new Error('wasm fetch failed');
      }
      return runs;
    });

    await expect(init()).rejects.toThrow('wasm fetch failed');
    expect(await init()).toBe(2);
    expect(await init()).toBe(2);
    expect(runs).toBe(2);
  });

  it('gives every racing caller the same rejection, without re-running', async () => {
    let runs = 0;
    const gate = deferred<void>();
    const init = once(async () => {
      runs++;
      await gate.promise;
      return 1;
    });
    const a = init();
    const b = init();
    gate.reject(new Error('boom'));
    await expect(a).rejects.toThrow('boom');
    await expect(b).rejects.toThrow('boom');
    expect(runs).toBe(1);
  });
});

/**
 * Source-level guard for the worker itself. The worker is a DedicatedWorker
 * module that touches IndexedDB and wasm at import time, so it cannot be
 * imported here — but the property that broke is textual: the wasm
 * initializers must go through `once`, not a bare null check.
 *
 * Without it, two concurrent `await initWasm()` calls both initialize the same
 * wasm instance; the second `initThreadPool` throws, the throw is swallowed by
 * the "degrade to sequential" handler, and trial decryption silently runs on
 * one core (measured: ~84 ms vs ~10 ms per 3000 actions on a 32-core host).
 */
const WORKER_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'zcash-worker.ts'),
  'utf8',
);

describe('zcash-worker wasm init', () => {
  it('memoizes the in-flight init instead of a bare null guard', () => {
    expect(WORKER_SRC).toContain('const initWasm = once(');
    expect(WORKER_SRC).toContain('const initZync = once(');
  });

  it('still initializes the rayon pool inside initWasm', () => {
    const start = WORKER_SRC.indexOf('const initWasm = once(');
    const end = WORKER_SRC.indexOf('const initZync = once(');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(WORKER_SRC.slice(start, end)).toContain('initThreadPool');
  });
});
