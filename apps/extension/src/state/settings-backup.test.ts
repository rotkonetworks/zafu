import { describe, expect, it, vi } from 'vitest';

const store: Record<string, unknown> = {
  autoLockMinutes: 5,
  zafuTheme: 'washi',
  hiddenTransparentChains: ['osmosis'],
  penumbraTotalIn: 'um',
  penumbraRowsInUsd: ['16ztCNRCyQZYu3cNN7DNMevUt0v2pERpUBflNfwP+wc='],
  swapRoutes: { 'into_zec:btc@btc': 'thor' },
  peopleRelay: { endpoint: 'https://relay.example.org', hosts: ['https://relay.zafu.pro'] },
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
  it('carries privacy without retired keys, and the stored preferences', async () => {
    const out = await exportSettings({
      ...DEFAULT_PRIVACY_SETTINGS,
      hideBalances: true,
      proxy: { enabled: true, host: 'x', port: 1 },
    } as never);
    expect(out.privacy?.hideBalances).toBe(true);
    expect(out.privacy).not.toHaveProperty('proxy');
    expect(out.prefs).toEqual({
      autoLockMinutes: 5,
      zafuTheme: 'washi',
      hiddenTransparentChains: ['osmosis'],
      penumbraTotalIn: 'um',
      penumbraRowsInUsd: ['16ztCNRCyQZYu3cNN7DNMevUt0v2pERpUBflNfwP+wc='],
      swapRoutes: { 'into_zec:btc@btc': 'thor' },
      peopleRelay: { endpoint: 'https://relay.example.org', hosts: ['https://relay.zafu.pro'] },
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
    expect(next).not.toHaveProperty('proxy');
  });

  it('carries the zcash per-block transparent check and restores it', async () => {
    const out = await exportSettings({
      ...DEFAULT_PRIVACY_SETTINGS,
      zcashTransparentEachBlock: true,
    });
    expect(out.privacy?.zcashTransparentEachBlock).toBe(true);
    const back = restoredPrivacy(DEFAULT_PRIVACY_SETTINGS, JSON.parse(JSON.stringify(out.privacy)));
    expect(back.zcashTransparentEachBlock).toBe(true);
    // an older backup without the field leaves it off
    expect(restoredPrivacy(DEFAULT_PRIVACY_SETTINGS, {}).zcashTransparentEachBlock).toBe(false);
  });

  it("a backup from before v5 restores penumbra's keep-syncing from the old shared name", () => {
    const legacy = { enableBackgroundSync: true } as never;
    expect(restoredPrivacy(DEFAULT_PRIVACY_SETTINGS, legacy).keepPenumbraSyncing).toBe(true);
    expect(restoredPrivacy(DEFAULT_PRIVACY_SETTINGS, legacy).transparentBackgroundSync).toBe(false);
  });

  it('writes back only the preferences a backup has', async () => {
    await importPrefs({
      zafuFont: 'system',
      hiddenTransparentChains: ['injective'],
      penumbraTotalIn: 'usd',
      swapRoutes: { 'from_zec:eth@eth': 'near' },
    });
    expect(store['swapRoutes']).toEqual({ 'from_zec:eth@eth': 'near' });
    expect(store['zafuFont']).toBe('system');
    expect(store['hiddenTransparentChains']).toEqual(['injective']);
    expect(store['penumbraTotalIn']).toBe('usd');
    expect(store['autoLockMinutes']).toBe(5);
  });

  it('leaves a never-chosen total out of the backup, so a restore keeps the default', async () => {
    delete store['penumbraTotalIn'];
    const out = await exportSettings(DEFAULT_PRIVACY_SETTINGS);
    expect(out.prefs).not.toHaveProperty('penumbraTotalIn');
    await importPrefs(out.prefs);
    expect(store['penumbraTotalIn']).toBeUndefined();
  });

  it('carries the zcash node choice, not its kind: the node says what it is again', async () => {
    store['networkEndpoints'] = { zcash: 'https://zcash.example' };
    store['zcashBackend'] = 'lightwalletd';
    const out = await exportSettings(DEFAULT_PRIVACY_SETTINGS);
    expect(out.prefs?.networkEndpoints).toEqual({ zcash: 'https://zcash.example' });
    expect(out.prefs).not.toHaveProperty('zcashBackend');
  });
});
