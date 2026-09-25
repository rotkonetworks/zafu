import { describe, expect, it } from 'vitest';
import { createRebuildScheduler } from './rebuild-scheduler';

interface Target {
  walletIndex: number;
  run: boolean;
}

const setup = (initialDesired: Target) => {
  let desired = initialDesired;
  const rebuilds: { target: Target; why: string }[] = [];
  let active = 0;
  let maxConcurrent = 0;
  let release: (() => void) | undefined;
  let holdNext = false;

  const s = createRebuildScheduler<Target>({
    desired: () => Promise.resolve(desired),
    same: (a, b) => a.walletIndex === b.walletIndex && a.run === b.run,
    rebuild: async (target, _prev, why) => {
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      rebuilds.push({ target, why });
      if (holdNext) {
        holdNext = false;
        await new Promise<void>(r => {
          release = r;
        });
      }
      active -= 1;
    },
  });
  return {
    s,
    rebuilds,
    setDesired: (t: Target) => {
      desired = t;
    },
    hold: () => {
      holdNext = true;
    },
    release: () => release?.(),
    maxConcurrent: () => maxConcurrent,
  };
};

describe('createRebuildScheduler', () => {
  it('skips a rebuild when the target equals what is running', async () => {
    const t = setup({ walletIndex: 0, run: true });
    t.s.setRunning({ walletIndex: 0, run: true });
    await t.s.request('network switch');
    expect(t.rebuilds).toHaveLength(0);
  });

  it('rebuilds when the target changes', async () => {
    const t = setup({ walletIndex: 0, run: true });
    t.s.setRunning({ walletIndex: 0, run: false });
    await t.s.request('dapp session started');
    expect(t.rebuilds.map(r => r.why)).toEqual(['dapp session started']);
    expect(t.s.getRunning()).toEqual({ walletIndex: 0, run: true });
  });

  it('coalesces a burst of requests into one rebuild', async () => {
    const t = setup({ walletIndex: 1, run: true });
    t.s.setRunning({ walletIndex: 0, run: true });
    await Promise.all([t.s.request('a'), t.s.request('b'), t.s.request('c'), t.s.request('d')]);
    expect(t.rebuilds).toHaveLength(1);
  });

  it('never runs two rebuilds at once (no orphaned block processors)', async () => {
    const t = setup({ walletIndex: 1, run: true });
    t.s.setRunning({ walletIndex: 0, run: true });
    t.hold();
    const first = t.s.request('wallet switch');
    // let the first rebuild start and block
    await new Promise(r => setTimeout(r, 0));
    t.setDesired({ walletIndex: 2, run: true });
    const second = t.s.request('wallet switch again');
    await new Promise(r => setTimeout(r, 0));
    expect(t.rebuilds).toHaveLength(1); // second is queued, not running
    t.release();
    await Promise.all([first, second]);
    expect(t.rebuilds.map(r => r.target.walletIndex)).toEqual([1, 2]);
    expect(t.maxConcurrent()).toBe(1);
  });

  it('drops a queued request whose target reverted to what is running', async () => {
    const t = setup({ walletIndex: 1, run: true });
    t.s.setRunning({ walletIndex: 0, run: true });
    t.hold();
    const first = t.s.request('switch to 1');
    await new Promise(r => setTimeout(r, 0));
    // user flips back to 1 again before the first finishes -> nothing new to do
    const second = t.s.request('switch to 1 again');
    t.release();
    await Promise.all([first, second]);
    expect(t.rebuilds).toHaveLength(1);
  });

  it('keeps working after a failed rebuild', async () => {
    const errors: unknown[] = [];
    let fail = true;
    const s = createRebuildScheduler<number>({
      desired: () => Promise.resolve(Math.random()),
      same: (a, b) => a === b,
      rebuild: () => {
        if (fail) {
          fail = false;
          return Promise.reject(new Error('boom'));
        }
        return Promise.resolve();
      },
      onError: e => errors.push(e),
    });
    await s.request('first');
    await s.request('second');
    expect(errors).toHaveLength(1);
  });
});
