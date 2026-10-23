import { describe, expect, it } from 'vitest';
import { waitForSync } from './sync-gate';

const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
};

describe('waitForSync', () => {
  it('goes straight through when synced', async () => {
    let waited = false;
    await waitForSync({
      status: async () => ({ catchingUp: false, fullSyncHeight: 100n }),
      onWaiting: () => void (waited = true),
      ...clock(),
    });
    expect(waited).toBe(false);
  });

  it('waits, once, for the scan to catch up', async () => {
    let h = 90n;
    let told = 0;
    await waitForSync({
      status: async () => ({ catchingUp: (h += 2n) < 100n, fullSyncHeight: h }),
      onWaiting: () => void told++,
      ...clock(),
    });
    expect(told).toBe(1);
    expect(h).toBeGreaterThanOrEqual(100n);
  });

  it('refuses when the wallet never catches up', async () => {
    await expect(
      waitForSync({
        status: async () => ({ catchingUp: true, fullSyncHeight: 50n }),
        waitMs: 10_000,
        ...clock(),
      }),
    ).rejects.toThrow(/still syncing \(at block 50\) · nothing was sent/);
  });

  it('passes a status failure through rather than sending blind', async () => {
    await expect(
      waitForSync({
        status: async () => {
          throw new Error('view service down');
        },
        ...clock(),
      }),
    ).rejects.toThrow('view service down');
  });
});
