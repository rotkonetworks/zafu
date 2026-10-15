import { describe, expect, it, vi } from 'vitest';
import { queuedPass } from './queued-pass';

const later = () => {
  let done!: () => void;
  const p = new Promise<void>(r => (done = r));
  return { p, done };
};

describe('queuedPass', () => {
  it('runs once per ask when nothing overlaps', async () => {
    const start = vi.fn(() => Promise.resolve());
    const go = queuedPass(start);
    go();
    await Promise.resolve();
    await new Promise(r => setTimeout(r, 0));
    go();
    await new Promise(r => setTimeout(r, 0));
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('asks during a pass become exactly one more pass after it', async () => {
    const first = later();
    const start = vi.fn().mockReturnValueOnce(first.p).mockResolvedValue(undefined);
    const go = queuedPass(start);
    go();
    go();
    go();
    expect(start).toHaveBeenCalledTimes(1);
    first.done();
    await new Promise(r => setTimeout(r, 0));
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('a failed pass still lets the next one run', async () => {
    const start = vi
      .fn()
      .mockRejectedValueOnce(new Error('node down'))
      .mockResolvedValue(undefined);
    const go = queuedPass(start);
    go();
    await new Promise(r => setTimeout(r, 0));
    go();
    await new Promise(r => setTimeout(r, 0));
    expect(start).toHaveBeenCalledTimes(2);
  });
});
