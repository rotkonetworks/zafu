import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { beforeEach, describe, expect, test } from 'vitest';
import { create } from 'zustand';
import { AllSlices, initializeStore, TestStore } from '.';
import {
  forgetYourAddress,
  readYourAddresses,
  rememberYourAddress,
  restoreYourAddresses,
  yoursOn,
} from './your-addresses';
import { clearPersonalData } from './personal-data';

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;
const sessionMock = (chrome.storage.session as unknown as { mock: Map<string, unknown> }).mock;

const BTC = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
const ETH = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const ZID = 'ab'.repeat(32);

describe('yours: your own addresses on other chains', () => {
  let useStore: TestStore;

  beforeEach(async () => {
    localMock.clear();
    sessionMock.clear();
    useStore = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
    await useStore.getState().keyRing.setPassword('s0meUs3rP@ssword');
  });

  test('are sealed at rest', async () => {
    await rememberYourAddress({ owner: 'zid-a', chain: 'bitcoin', address: BTC });
    const raw = localMock.get('yourAddresses');
    expect(raw).toHaveProperty('encrypted');
    expect(JSON.stringify(raw)).not.toContain(BTC);
    expect((await readYourAddresses()).map(y => y.address)).toEqual([BTC]);
  });

  test('keep one per wallet, chain and address, the newest first', async () => {
    await rememberYourAddress({ owner: 'zid-a', chain: 'bitcoin', address: BTC });
    await rememberYourAddress({ owner: 'zid-a', chain: 'ethereum', address: ETH });
    await rememberYourAddress({ owner: 'zid-a', chain: 'bitcoin', address: ` ${BTC} ` });
    await rememberYourAddress({ owner: 'zid-b', chain: 'bitcoin', address: BTC });
    const list = await readYourAddresses();
    expect(list).toHaveLength(3);
    expect(yoursOn(list, 'zid-a', 'bitcoin').map(y => y.address)).toEqual([BTC]);
    expect(yoursOn(list, 'zid-a', 'base')).toEqual([]);
    await forgetYourAddress({ owner: 'zid-b', chain: 'bitcoin', address: BTC });
    expect(await readYourAddresses()).toHaveLength(2);
  });

  test('never hold a zid or another chain’s address', async () => {
    await expect(
      rememberYourAddress({ owner: 'zid-a', chain: 'bitcoin', address: ZID }),
    ).rejects.toThrow();
    await expect(
      rememberYourAddress({ owner: 'zid-a', chain: 'bitcoin', address: ETH }),
    ).rejects.toThrow();
    expect(await readYourAddresses()).toEqual([]);
    // 64 hex is a near implicit account only on near
    await rememberYourAddress({ owner: 'zid-a', chain: 'near', address: ZID });
    expect(await readYourAddresses()).toHaveLength(1);
  });

  test('a backup round trip brings them back, without duplicates', async () => {
    await rememberYourAddress({ owner: 'zid-a', chain: 'bitcoin', address: BTC });
    await rememberYourAddress({ owner: 'zid-a', chain: 'base', address: ETH });
    const before = await readYourAddresses();
    const backup = await useStore.getState().contacts.exportPersonalData('backup-pass');
    await clearPersonalData({ notes: false, sent: false });
    expect(localMock.has('yourAddresses')).toBe(false);

    await useStore.getState().contacts.importPersonalData(backup, 'backup-pass', 'merge');
    expect(await readYourAddresses()).toEqual(before);
    await useStore.getState().contacts.importPersonalData(backup, 'backup-pass', 'merge');
    expect(await readYourAddresses()).toHaveLength(2);
  });

  test('a restore skips anything that is not an address on its chain', async () => {
    const n = await restoreYourAddresses(
      [
        { owner: 'zid-a', chain: 'bitcoin', address: BTC, savedAt: 1 },
        { owner: 'zid-a', chain: 'bitcoin', address: ZID, savedAt: 1 },
        { owner: 'zid-a', chain: 'solana', address: 'hello', savedAt: 1 },
        null,
      ],
      'replace',
    );
    expect(n).toBe(1);
    expect((await readYourAddresses()).map(y => y.address)).toEqual([BTC]);
  });
});
