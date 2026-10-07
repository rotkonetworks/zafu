import { describe, expect, it, vi } from 'vitest';

const store: Record<string, unknown> = {
  autoLockMinutes: 5,
  zafuTheme: 'washi',
  penumbraTotalIn: 'um',
  penumbraRowsInUsd: ['16ztCNRCyQZYu3cNN7DNMevUt0v2pERpUBflNfwP+wc='],
  swapRoutes: { 'into_zec:btc@btc': 'thor' },
  swapCustodyAck: ['near'],
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
import { exportSettings, importBirthdays, importPrefs, restoredPrivacy } from './settings-backup';

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
      penumbraTotalIn: 'um',
      penumbraRowsInUsd: ['16ztCNRCyQZYu3cNN7DNMevUt0v2pERpUBflNfwP+wc='],
      swapRoutes: { 'into_zec:btc@btc': 'thor' },
      swapCustodyAck: ['near'],
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
  });

  it('writes back only the preferences a backup has', async () => {
    await importPrefs({
      zafuFont: 'system',
      penumbraTotalIn: 'usd',
      swapRoutes: { 'from_zec:eth@eth': 'near' },
    });
    expect(store['swapRoutes']).toEqual({ 'from_zec:eth@eth': 'near' });
    expect(store['zafuFont']).toBe('system');
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

  const chosen = {
    memoSyncStrategies: { zcash: 'fast' },
    mempoolWatchSettings: { zcash: 'on' },
    zcashMeConfig: {
      mode: 'live',
      mirrorUrl: '',
      apiKey: 'own-key',
      promptDismissed: true,
      decoys: 4,
    },
    capabilityModes: { 'zid-discovery': 'disabled' },
    enabledNetworks: ['zcash', 'penumbra'],
    keplrCompat: true,
  };

  it.each(Object.entries(chosen))('carries %s through a backup and back', async (k, v) => {
    store[k] = v;
    const out = JSON.parse(JSON.stringify(await exportSettings(DEFAULT_PRIVACY_SETTINGS))) as {
      prefs: Record<string, unknown>;
    };
    delete store[k];
    await importPrefs(out.prefs);
    expect(store[k]).toEqual(v);
    delete store[k];
  });

  it('leaves out a restored value of the wrong shape, and networks zafu no longer has', async () => {
    await importPrefs({
      memoSyncStrategies: { zcash: 'loud' },
      mempoolWatchSettings: 'on',
      zcashMeConfig: { mode: 'loud' },
      capabilityModes: { x: true },
      keplrCompat: 'yes',
      enabledNetworks: ['zcash', 'polkadot'],
    });
    for (const k of ['memoSyncStrategies', 'mempoolWatchSettings', 'zcashMeConfig']) {
      expect(store).not.toHaveProperty(k);
    }
    expect(store).not.toHaveProperty('capabilityModes');
    expect(store).not.toHaveProperty('keplrCompat');
    expect(store['enabledNetworks']).toEqual(['zcash']);
    delete store['enabledNetworks'];
    await importPrefs({ enabledNetworks: ['polkadot'] });
    expect(store).not.toHaveProperty('enabledNetworks');
  });

  it('restores a zcash.me config stored before its later fields existed', async () => {
    await importPrefs({ zcashMeConfig: { mode: 'directory', mirrorUrl: '', apiKey: '' } });
    expect(store['zcashMeConfig']).toEqual({ mode: 'directory', mirrorUrl: '', apiKey: '' });
    delete store['zcashMeConfig'];
  });

  it('restores an older backup without the new keys, and ignores the retired ones', async () => {
    const before = { ...store };
    await importPrefs({ hiddenTransparentChains: ['osmosis'] } as never);
    await importBirthdays(undefined, [{ id: 'v1', owner: 'zid-a' }]);
    expect(store).toEqual(before);
    expect(await chrome.storage.local.get('zcashBirthday_v1')).toEqual({});
  });

  it("puts each wallet's start height back on the wallet with the same owner, skipping the rest", async () => {
    await chrome.storage.local.set({ zcashBirthday_old: 2_100_000 });
    const out = await exportSettings(DEFAULT_PRIVACY_SETTINGS, [
      { id: 'old', owner: 'zid-a' },
      { id: 'none', owner: 'zid-c' },
    ]);
    expect(out.birthdays).toEqual({ 'zid-a': 2_100_000 });
    await importBirthdays(JSON.parse(JSON.stringify(out.birthdays)) as Record<string, number>, [
      { id: 'new', owner: 'zid-a' },
      { id: 'other', owner: 'zid-b' },
    ]);
    expect(await chrome.storage.local.get(['zcashBirthday_new', 'zcashBirthday_other'])).toEqual({
      zcashBirthday_new: 2_100_000,
    });
    await importBirthdays({ 'zid-b': -1, 'zid-a': 'x' as never }, [
      { id: 'other', owner: 'zid-b' },
      { id: 'new2', owner: 'zid-a' },
    ]);
    expect(await chrome.storage.local.get(['zcashBirthday_other', 'zcashBirthday_new2'])).toEqual(
      {},
    );
  });
});
