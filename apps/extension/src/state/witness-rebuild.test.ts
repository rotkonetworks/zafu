import { describe, expect, it } from 'vitest';
import { catchUpLeft, catchUpShare, catchUpStep, type CatchUp } from './witness-rebuild';

const start = (now = 0) =>
  catchUpStep(undefined, 'catch-up: start', 'reason=moved from=3000001 to=3060000', now)!;

describe('catchUpStep', () => {
  it('starts on the worker label with its reason and real range', () => {
    expect(start(5)).toEqual({ since: 5, reason: 'moved', from: 3000001, to: 3060000 });
  });

  it('counts fetched blocks and keeps the first start', () => {
    let c: CatchUp | undefined = start(5);
    c = catchUpStep(c, 'catch-up: blocks', 'done=1000 total=60000', 9);
    c = catchUpStep(c, 'catch-up: start', 'reason=diverged from=1 to=2', 12);
    expect(c).toMatchObject({ since: 5, reason: 'diverged' });
    c = catchUpStep(start(5), 'catch-up: blocks', 'done=1000 total=60000', 9);
    expect(c).toMatchObject({ done: 1000, total: 60000, firstAt: 9, firstDone: 1000 });
  });

  it('ends on any later stage, and ignores labels when none is running', () => {
    for (const step of ['witnesses built', 'proving (halo2)', 'complete', 'loading wallet state']) {
      expect(catchUpStep(start(), step, undefined, 9)).toBeUndefined();
    }
    expect(catchUpStep(undefined, 'catch-up: blocks', 'done=1 total=2', 9)).toBeUndefined();
  });

  it('never names corruption for an ordinary catch-up', () => {
    expect(
      catchUpStep(undefined, 'catch-up: start', 'reason=unwitnessed from=1 to=9', 0)?.reason,
    ).toBe('unwitnessed');
  });
});

describe('catchUpLeft', () => {
  it('says nothing until two batches give a real rate', () => {
    let c: CatchUp | undefined = start(0);
    expect(catchUpLeft(c)).toBeUndefined();
    c = catchUpStep(c, 'catch-up: blocks', 'done=1000 total=61000', 1_000);
    expect(catchUpLeft(c)).toBeUndefined();
    // 1000 blocks/s measured: 59000 left is about 1 min
    c = catchUpStep(c, 'catch-up: blocks', 'done=2000 total=61000', 2_000);
    expect(catchUpLeft(c)).toBe('about 1 min left');
    c = catchUpStep(c, 'catch-up: blocks', 'done=51000 total=61000', 51_000);
    expect(catchUpLeft(c)).toBe('about 10s left');
    expect(catchUpShare(c)).toBeCloseTo(51 / 61);
  });

  it('stops estimating once the tree is being replayed', () => {
    let c: CatchUp | undefined = start(0);
    c = catchUpStep(c, 'catch-up: blocks', 'done=1000 total=2000', 1_000);
    c = catchUpStep(c, 'catch-up: blocks', 'done=2000 total=2000', 2_000);
    c = catchUpStep(c, 'catch-up: replaying', '2000 blocks', 2_100);
    expect(catchUpLeft(c)).toBeUndefined();
    expect(catchUpShare(c)).toBe(1);
  });
});
