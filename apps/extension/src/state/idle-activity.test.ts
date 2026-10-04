import { beforeEach, describe, expect, it } from 'vitest';
import { LAST_ACTIVITY_KEY, idleFor } from './idle-activity';

describe('auto-lock clock', () => {
  beforeEach(async () => {
    await chrome.storage.session.remove(LAST_ACTIVITY_KEY);
  });

  it('reads the clock from session storage, so a fresh worker still sees the idle time', async () => {
    const t = 1_000_000_000;
    await chrome.storage.session.set({ [LAST_ACTIVITY_KEY]: t });
    expect(await idleFor(15, t + 14 * 60_000)).toBe(false);
    expect(await idleFor(15, t + 15 * 60_000)).toBe(true);
  });

  it('starts the clock instead of locking when there is none', async () => {
    const t = 2_000_000_000;
    expect(await idleFor(15, t)).toBe(false);
    expect((await chrome.storage.session.get(LAST_ACTIVITY_KEY))[LAST_ACTIVITY_KEY]).toBe(t);
    expect(await idleFor(15, t + 16 * 60_000)).toBe(true);
  });
});
