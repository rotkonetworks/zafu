import { MockStorageArea } from '@repo/mock-chrome/mocks/storage-area';
import { beforeEach, describe, expect, test } from 'vitest';
import { ExtensionStorage, ExtensionStorageDefaults } from '../base';
import { VERSION_FIELD } from '../version-field';
import * as Storage_V5 from '../versions/v5';
import local_v0_v1 from './local-v0-v1';
import local_v1_v2 from './local-v1-v2';
import local_v2_v3 from './local-v2-v3';
import local_v3_v4 from './local-v3-v4';
import local_v4_v5 from './local-v4-v5';

const defaultData: ExtensionStorageDefaults<Storage_V5.LOCAL> = {
  penumbraWallets: [],
  knownSites: [],
  numeraires: [],
};

const storageArea = new MockStorageArea();
let v5: ExtensionStorage<Storage_V5.LOCAL, Storage_V5.VERSION>;

const v4With = (privacySettings: unknown) =>
  storageArea.set({
    [VERSION_FIELD]: 4,
    penumbraWallets: [],
    knownSites: [],
    numeraires: [],
    privacySettings,
  });

const settings = (enableBackgroundSync?: boolean) => ({
  enableTransparentBalances: false,
  enableTransactionHistory: true,
  enablePriceFetching: false,
  hideBalances: true,
  ...(enableBackgroundSync === undefined ? {} : { enableBackgroundSync }),
});

describe('local-v4-v5 migration (split enableBackgroundSync)', () => {
  beforeEach(async () => {
    await storageArea.clear();
    v5 = new ExtensionStorage<Storage_V5.LOCAL, Storage_V5.VERSION>(storageArea, defaultData, 5, {
      0: local_v0_v1,
      1: local_v1_v2,
      2: local_v2_v3,
      3: local_v3_v4,
      4: local_v4_v5,
    });
  });

  test("an on flag was penumbra's keep-syncing switch: it stays on, transparent stays off", async () => {
    await v4With(settings(true));
    expect(await v5.get('privacySettings')).toEqual({
      enableTransparentBalances: false,
      enableTransactionHistory: true,
      enablePriceFetching: false,
      hideBalances: true,
      keepPenumbraSyncing: true,
      transparentBackgroundSync: false,
    });
  });

  test('an off or unset flag leaves both off, and every other setting as it was', async () => {
    await v4With(settings(false));
    const off = await v5.get('privacySettings');
    expect(off).toMatchObject({ keepPenumbraSyncing: false, transparentBackgroundSync: false });
    expect(off).not.toHaveProperty('enableBackgroundSync');

    await storageArea.clear();
    await v4With(settings());
    expect(await v5.get('privacySettings')).toMatchObject({
      hideBalances: true,
      keepPenumbraSyncing: false,
      transparentBackgroundSync: false,
    });
  });

  test('a sealed box is passed through unopened', async () => {
    const sealed = { encrypted: 'opaque', nonce: 'n' };
    await v4With(sealed);
    expect(await v5.get('privacySettings')).toEqual(sealed);
  });

  test('no settings stored, or something unreadable: untouched', async () => {
    await storageArea.set({
      [VERSION_FIELD]: 4,
      penumbraWallets: [],
      knownSites: [],
      numeraires: [],
    });
    expect(await v5.get('privacySettings')).toBeUndefined();

    await storageArea.clear();
    await v4With('garbage');
    expect(await v5.get('privacySettings')).toBe('garbage');
  });

  test('other keys survive', async () => {
    await storageArea.set({
      [VERSION_FIELD]: 4,
      penumbraWallets: [],
      knownSites: [],
      numeraires: [],
      activeNetwork: 'penumbra',
      privacySettings: settings(true),
    });
    expect(await v5.get('activeNetwork')).toBe('penumbra');
  });
});
