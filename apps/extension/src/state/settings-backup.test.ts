import { describe, expect, it, vi } from 'vitest';

const store: Record<string, unknown> = {
  autoLockMinutes: 5,
  zafuTheme: 'washi',
  hiddenTransparentChains: ['osmosis'],
};
vi.mock('@repo/storage-chrome/local', () => ({
  localExtStorage: {
    get: async (k: string) => store[k],
    set: async (k: string, v: unknown) => {
      store[k] = v;
    },
  },
}));

import { DEFAULT_PRIVACY_SETTINGS } from './privacy';
import { exportSettings, importPrefs, restoredPrivacy } from './settings-backup';

describe('settings backup', () => {
  it('carries privacy without the proxy, and the stored preferences', async () => {
    const out = await exportSettings({ ...DEFAULT_PRIVACY_SETTINGS, hideBalances: true });
    expect(out.privacy?.hideBalances).toBe(true);
    expect(out.privacy).not.toHaveProperty('proxy');
    expect(out.prefs).toEqual({
      autoLockMinutes: 5,
      zafuTheme: 'washi',
      hiddenTransparentChains: ['osmosis'],
    });
  });

  it('restores known keys of the right type and leaves the rest', () => {
    const next = restoredPrivacy(DEFAULT_PRIVACY_SETTINGS, {
      hideBalances: true,
      historyAsked: true,
      txSigningSecurity: 'foilhat',
      enableExplorerLinks: 'yes' as never,
      proxy: { enabled: true, host: 'x', port: 1 },
    });
    expect(next.hideBalances).toBe(true);
    expect(next.historyAsked).toBe(true);
    expect(next.txSigningSecurity).toBe('foilhat');
    expect(next.enableExplorerLinks).toBe(false);
    expect(next.proxy).toEqual(DEFAULT_PRIVACY_SETTINGS.proxy);
  });

  it('writes back only the preferences a backup has', async () => {
    await importPrefs({ zafuFont: 'system', hiddenTransparentChains: ['injective'] });
    expect(store['zafuFont']).toBe('system');
    expect(store['hiddenTransparentChains']).toEqual(['injective']);
    expect(store['autoLockMinutes']).toBe(5);
  });
});
