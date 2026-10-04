import { describe, expect, it, vi } from 'vitest';
import { startRun, stopRun, type RunSlot } from './sync-runs';

/** a run body that holds until released or stopped, recording what it saw */
const holdingBody = (log: string[], name: string) => {
  let release!: () => void;
  const held = new Promise<void>(r => (release = r));
  const body = async (signal: AbortSignal) => {
    log.push(`${name} start`);
    await Promise.race([held, new Promise(r => signal.addEventListener('abort', r))]);
    log.push(`${name} end aborted=${signal.aborted}`);
  };
  return { body, release };
};

describe('one sync run per wallet', () => {
  it('a restart starts only after the run before it has ended', async () => {
    const slot: RunSlot = {};
    const log: string[] = [];
    const a = holdingBody(log, 'a');
    void startRun(slot, a.body, () => log.push('a ended'));
    await vi.waitFor(() => expect(log).toContain('a start'));
    const b = holdingBody(log, 'b');
    const second = startRun(slot, b.body, () => log.push('b ended'));
    await vi.waitFor(() => expect(log).toContain('b start'));
    expect(log.indexOf('a end aborted=true')).toBeLessThan(log.indexOf('b start'));
    b.release();
    await second;
    // the replaced run never reports the wallet idle under its successor
    expect(log).not.toContain('a ended');
    expect(log.at(-1)).toBe('b ended');
  });

  it('a stop that lands while a run is still starting ends it before it fetches anything', async () => {
    const slot: RunSlot = {};
    const log: string[] = [];
    const a = holdingBody(log, 'a');
    void startRun(slot, a.body, () => log.push('a ended'));
    const b = holdingBody(log, 'b');
    const second = startRun(slot, b.body, () => log.push('b ended'));
    await stopRun(slot);
    await second;
    expect(log).not.toContain('b start');
    expect(log).toContain('b ended');
  });

  it('a run that ends on its own (a fatal error) still reports the wallet idle', async () => {
    const slot: RunSlot = {};
    const ended = vi.fn();
    await startRun(slot, () => Promise.reject(new Error('store would not open')), ended);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('a run wedged in a fetch delays the next one only up to the wait, and stays aborted', async () => {
    const slot: RunSlot = {};
    let wedged: AbortSignal | undefined;
    void startRun(
      slot,
      signal => {
        wedged = signal;
        return new Promise(() => {});
      },
      () => {},
      20,
    );
    await vi.waitFor(() => expect(wedged).toBeDefined());
    const started = vi.fn(async () => {});
    await startRun(slot, started, () => {}, 20);
    expect(started).toHaveBeenCalledTimes(1);
    expect(wedged?.aborted).toBe(true);
  });
});
