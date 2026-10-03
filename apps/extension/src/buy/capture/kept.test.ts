import { beforeEach, describe, expect, it, vi } from 'vitest';

const { remove } = vi.hoisted(() => ({ remove: vi.fn(() => Promise.resolve(true)) }));

import { readBuyPrefs, writeBuyPrefs } from '../store';
import { KEEP_DAYS, keepCaptureAccess, keptCaptureAccess } from './kept';

const DAY = 24 * 60 * 60_000;

beforeEach(async () => {
  remove.mockClear();
  (globalThis.chrome as unknown as { permissions: unknown }).permissions = { remove };
  await writeBuyPrefs({ kept: [], keptUntil: undefined });
});

describe('kept capture access', () => {
  it(`stays for ${KEEP_DAYS} days, then is given back`, async () => {
    const t = 1_700_000_000_000;
    await keepCaptureAccess('revolut', t);
    expect(await keptCaptureAccess(t + (KEEP_DAYS - 1) * DAY)).toBe(true);
    expect(remove).not.toHaveBeenCalled();

    expect(await keptCaptureAccess(t + KEEP_DAYS * DAY)).toBe(false);
    expect(remove).toHaveBeenCalledWith({ permissions: ['webRequest', 'scripting'] });
    expect((await readBuyPrefs()).kept).toEqual([]);
  });

  it('gives back a grant kept before the time limit existed', async () => {
    await writeBuyPrefs({ kept: ['wise'] });
    expect(await keptCaptureAccess()).toBe(false);
    expect(remove).toHaveBeenCalled();
  });

  it('touches nothing when nothing was kept', async () => {
    expect(await keptCaptureAccess()).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });
});
