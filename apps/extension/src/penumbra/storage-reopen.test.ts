import { describe, expect, it, vi } from 'vitest';
import { createStorageReopen, STORAGE_REOPEN_MAX } from './storage-reopen';

const setup = (height: number | undefined = 100) => {
  const timers: (() => void)[] = [];
  const deps = {
    reopen: vi.fn(),
    mayReopen: () => true,
    kind: (e: unknown) => ((e as Error).message === 'quota' ? 'fatal' : 'reopen') as 'fatal' | 'reopen',
    stopped: vi.fn(),
    height: () => Promise.resolve(height),
    wait: (fn: () => void) => void timers.push(fn),
    log: { warn: () => undefined, error: () => undefined },
  };
  const r = createStorageReopen(deps);
  const flush = async () => {
    await Promise.resolve();
    timers.splice(0).forEach(fn => fn());
  };
  return { r, deps, flush };
};

describe('penumbra storage reopen', () => {
  it('a full disk stops at once and says so', async () => {
    const { r, deps } = setup();
    r.failed(new Error('quota'));
    await Promise.resolve();
    expect(deps.stopped).toHaveBeenCalledTimes(1);
    expect(deps.reopen).not.toHaveBeenCalled();
  });

  it('closes in a row stop after the budget, and say so', async () => {
    const { r, deps, flush } = setup();
    for (let i = 0; i < STORAGE_REOPEN_MAX; i++) {
      r.failed(new Error('closing'));
      await flush();
    }
    expect(deps.reopen).toHaveBeenCalledTimes(STORAGE_REOPEN_MAX);
    r.failed(new Error('closing'));
    expect(deps.stopped).toHaveBeenCalledTimes(1);
  });

  it('a reopened processor that stores a block past the failure refills the budget', async () => {
    const { r, deps, flush } = setup(100);
    for (let i = 0; i < STORAGE_REOPEN_MAX; i++) {
      r.failed(new Error('closing'));
      await flush();
    }
    // the same height again is not progress
    r.progressed(100);
    expect(r.tries).toBe(STORAGE_REOPEN_MAX);
    r.progressed(101);
    expect(r.tries).toBe(0);
    // a long-lived worker's fourth close, hours later, reopens again
    r.failed(new Error('closing'));
    await flush();
    expect(deps.stopped).not.toHaveBeenCalled();
    expect(deps.reopen).toHaveBeenCalledTimes(STORAGE_REOPEN_MAX + 1);
  });
});
