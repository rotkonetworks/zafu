import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChainCheck } from './chain-check';

describe('chain-id check', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = (answers: (string | undefined)[], open = { value: true }) => {
    const asked: number[] = [];
    const rebuilt: string[] = [];
    const check = createChainCheck({
      windowOpen: () => open.value,
      refresh: () => {
        asked.push(Date.now());
        return Promise.resolve(answers.shift());
      },
      rebuild: why => rebuilt.push(why),
      retryMs: 1_000,
    });
    return { check, asked, rebuilt, open };
  };

  it('a confirmed id releases the hold and asks no more', async () => {
    const { check, asked } = setup(['penumbra-1']);
    const release = vi.fn();
    check.arm('penumbra-1', release);
    check.run();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(release).toHaveBeenCalledOnce();
    expect(asked).toHaveLength(1);
  });

  it('a changed id rebuilds and keeps the old processor held', async () => {
    const { check, rebuilt } = setup(['penumbra-2']);
    const release = vi.fn();
    check.arm('penumbra-1', release);
    check.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(rebuilt).toEqual(['chain id changed']);
    expect(release).not.toHaveBeenCalled();
  });

  it('no answer releases the hold, and asks again while a window is open', async () => {
    const { check, asked, rebuilt } = setup([undefined, 'penumbra-2']);
    const release = vi.fn();
    check.arm('penumbra-1', release);
    check.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(asked).toHaveLength(2);
    expect(rebuilt).toEqual(['chain id changed']);
  });

  it('with every window closed the retry waits for the next window', async () => {
    const open = { value: true };
    const { check, asked } = setup([undefined, 'penumbra-1'], open);
    check.arm('penumbra-1', () => undefined);
    check.run();
    await vi.advanceTimersByTimeAsync(0);
    open.value = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(asked).toHaveLength(1);

    // a window opens: the resume asks again
    open.value = true;
    check.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toHaveLength(2);
  });

  it('services replaced meanwhile: the old check is moot', async () => {
    const { check, asked, rebuilt } = setup([undefined, 'penumbra-2']);
    check.arm('penumbra-1', () => undefined);
    check.run();
    await vi.advanceTimersByTimeAsync(0);
    check.drop();
    await vi.advanceTimersByTimeAsync(5_000);
    check.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toHaveLength(1);
    expect(rebuilt).toEqual([]);
  });
});
