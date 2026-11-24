/**
 * One wallet on screen, one worker store, one viewing key.
 *
 * The store id comes from the selected wallet (activeZcashStoreId) and the
 * viewing key from the active zcash record (selectActiveZcashWallet). They
 * used to be chosen in two places (the vault and activeZcashIndex), and a
 * switch could move one without the other: a watch-only sync then filled one
 * wallet's store with another wallet's notes. The record now always comes
 * from the wallet on screen.
 */
import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { beforeEach, describe, expect, test } from 'vitest';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { AllSlices, initializeStore } from '.';
import { markHydrated, writeEncryptedDirect } from './encrypted-storage';
import { selectEffectiveKeyInfo } from './keyring';
import type { KeyInfo } from './keyring/types';
import { activeZcashStoreId } from './pockets';
import { selectActiveZcashWallet, selectMyWalletsAsContacts } from './wallets';

const vault = (id: string, type: KeyInfo['type'], nets?: string[]): KeyInfo => ({
  id,
  name: id,
  type,
  isSelected: false,
  createdAt: 0,
  insensitive: nets ? { supportedNetworks: nets } : {},
});
const record = (id: string, vaultId: string) => ({
  id,
  vaultId,
  label: id,
  accountIndex: 0,
  mainnet: true,
  address: `u1${id}`,
  ufvk: `uview-${id}`,
});

// two zcash zigners and a penumbra-only zigner (one zigner imported per network)
const A = vault('A', 'zigner-zafu', ['zcash']);
const B = vault('B', 'zigner-zafu', ['zcash']);
const P = vault('P', 'zigner-zafu', ['penumbra']);
const seed = vault('seed', 'mnemonic');
const records = [record('ra', 'A'), record('rb', 'B')];

let store: UseBoundStore<StoreApi<AllSlices>>;

/** the wallet on screen, the store it reads and the wallet whose key fills it */
const view = () => {
  const s = store.getState();
  return {
    key: selectEffectiveKeyInfo(s)?.id,
    store: activeZcashStoreId(s),
    viewKeyOf: selectActiveZcashWallet(s)?.vaultId,
  };
};

beforeEach(async () => {
  markHydrated();
  store = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
  await store.getState().keyRing.setPassword('a long test password');
  await writeEncryptedDirect(localExtStorage, sessionExtStorage, 'zcashWallets' as never, records);
  store.setState(s => {
    s.keyRing.keyInfos = [A, B, P, seed];
    s.keyRing.activeNetwork = 'zcash';
    s.keyRing.enabledNetworks = ['zcash', 'penumbra'];
    s.wallets.zcashWallets = records as never;
    s.wallets.activeZcashIndex = 0;
  });
});

describe('the store and the key that fills it are one wallet', () => {
  test('zcash wallet, then a penumbra-only one, then back to zcash', async () => {
    await store.getState().keyRing.selectKeyRing('B');
    expect(view()).toEqual({ key: 'B', store: 'B', viewKeyOf: 'B' });

    await store.getState().keyRing.selectKeyRing('P');
    await store.getState().keyRing.setActiveNetwork('penumbra');
    expect(view().key).toBe('P');

    // setActiveNetwork picks the first zcash wallet, A; the key is A's too
    await store.getState().keyRing.setActiveNetwork('zcash');
    expect(view()).toEqual({ key: 'A', store: 'A', viewKeyOf: 'A' });
  });

  test("an index left on another wallet's record is not taken", () => {
    store.setState(s => {
      s.keyRing.keyInfos = s.keyRing.keyInfos.map(k => ({ ...k, isSelected: k.id === 'A' }));
      s.keyRing.selectedKeyInfo = s.keyRing.keyInfos.find(k => k.isSelected);
      s.wallets.activeZcashIndex = 1; // B's record
    });
    expect(view()).toEqual({ key: 'A', store: 'A', viewKeyOf: 'A' });
  });

  test("a seed wallet has no record, and never borrows another wallet's", async () => {
    await store.getState().keyRing.selectKeyRing('seed');
    expect(view().key).toBe('seed');
    expect(selectActiveZcashWallet(store.getState())).toBeUndefined();
    // so every other wallet is offered as a recipient
    expect(selectMyWalletsAsContacts(store.getState()).map(c => c.id)).toEqual([
      'mywallet:ra',
      'mywallet:rb',
    ]);
  });
});
