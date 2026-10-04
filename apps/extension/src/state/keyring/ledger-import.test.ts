import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { create } from 'zustand';
import { AllSlices, initializeStore, TestStore } from '..';
import { createEncryptedLocal } from '../encrypted-storage';
import type { EncryptedVault } from './types';
import type { ZcashWalletJson } from '../wallets';
import {
  exportLedgerZcashAccount,
  saveLedgerZcashAccount,
  type BirthdayStore,
} from '../../ledger/zcash-app/import-account';
import type { LedgerZcashDevice } from '../../ledger/zcash-app/contract';

// the authoritative UFVK decoder is wasm; the import state logic is what is
// under test here, so accept any uview string.
vi.mock('@repo/zcash-wasm', () => ({
  default: async () => undefined,
  validate_ufvk: (s: string) => s.startsWith('uview1'),
}));

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;
const sessionMock = (chrome.storage.session as unknown as { mock: Map<string, unknown> }).mock;
const encryptedLocal = createEncryptedLocal(localExtStorage, sessionExtStorage);

const UFVK_A = 'uview1accountzeroaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const UFVK_B = 'uview1accountonebbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** a fake Ledger with one seed: account N exports UFVK_A for 0, UFVK_B otherwise */
const fakeLedger = (): LedgerZcashDevice => ({
  currentApp: async () => ({ name: 'Zcash', version: '3.9.4' }),
  openZcashApp: async () => ({ name: 'Zcash', version: '3.9.4' }),
  exchange: async () => [new Uint8Array([0x90, 0x00])],
  close: async () => undefined,
});
const fakeProtocol = {
  ufvkPlan: () => [
    { cla: 0x85, ins: 0x0b, p1: 0, p2: 0, data: new Uint8Array() },
    { cla: 0x85, ins: 0x0b, p1: 1, p2: 0, data: new Uint8Array() },
  ],
  ufvkRemainingBytes: (r: Uint8Array[]) => (r.length < 2 ? 100 : 0),
  parseUfvk: (_r: Uint8Array[], _n: 'main' | 'test', accountIndex: number) => ({
    ufvk: accountIndex === 0 ? UFVK_A : UFVK_B,
    seedFingerprint: new Uint8Array(32).fill(7),
    accountIndex,
  }),
};

const birthdayStore: BirthdayStore = {
  get: async key => (localMock.has(key) ? { [key]: localMock.get(key) } : {}),
  set: async items => {
    for (const [k, v] of Object.entries(items)) {
      localMock.set(k, v);
    }
  },
};

describe('connect ledger (shielded) -> keyring', () => {
  let useStore: TestStore;

  beforeEach(() => {
    localMock.clear();
    sessionMock.clear();
    useStore = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
  });

  const connectAndSave = async (accountIndex: number, birthdayHeight: number | null = null) => {
    const account = await exportLedgerZcashAccount(
      { device: fakeLedger(), protocol: fakeProtocol, network: 'main', productName: 'Nano X' },
      { accountIndex },
    );
    return saveLedgerZcashAccount(
      {
        addLedger: (d, n) => useStore.getState().keyRing.addLedgerUnencrypted(d, n),
        deriveAddress: async () => `u1address${accountIndex}`,
        birthdayStore,
        minBirthdayHeight: 1_687_104,
      },
      { account, label: '', mainnet: true, birthdayHeight },
    );
  };

  const vaults = async () => ((await localExtStorage.get('vaults')) ?? []) as EncryptedVault[];
  const zcashWallets = async () =>
    ((await encryptedLocal.get('zcashWallets')) ?? []) as ZcashWalletJson[];

  test('creates one shielded watch-only zcash wallet from the UFVK', async () => {
    const vaultId = await connectAndSave(0, 2_000_000);

    const [vault, ...moreVaults] = await vaults();
    expect(moreVaults).toHaveLength(0);
    expect(vault!.id).toBe(vaultId);
    expect(vault!.insensitive).toMatchObject({
      coldSignerType: 'ledger',
      custody: 'ledger-zcash',
      accountIndex: 0,
      seedFingerprint: '07'.repeat(32),
      appVersion: '3.9.4',
      deviceLabel: 'Ledger Nano X',
      supportedNetworks: ['zcash'],
    });
    // `vaults` is not encrypted at rest: the UFVK must never land there
    expect(JSON.stringify(vault!.insensitive)).not.toContain(UFVK_A);
    expect(JSON.stringify(vault!.insensitive)).not.toContain('u1address0');

    const wallets = await zcashWallets();
    expect(wallets).toHaveLength(1);
    expect(wallets[0]).toMatchObject({
      ufvk: UFVK_A,
      orchardFvk: UFVK_A,
      address: 'u1address0',
      accountIndex: 0,
      mainnet: true,
      vaultId,
      coldSignerType: 'ledger',
    });
    // the account facts live once, on the vault
    expect(wallets[0]).not.toHaveProperty('seedFingerprint');
    expect(wallets[0]!.transparentAddress).toBeUndefined();

    expect(localMock.get(`zcashBirthday_${vaultId}`)).toBe(2_000_000);
    expect(useStore.getState().keyRing.selectedKeyInfo?.id).toBe(vaultId);
    expect(useStore.getState().keyRing.enabledNetworks).toContain('zcash');
  });

  test('importing the same seedFingerprint + account again dedupes to the existing wallet', async () => {
    const first = await connectAndSave(0, 2_000_000);
    // an unrelated wallet gets selected in between
    await connectAndSave(1);
    expect(useStore.getState().keyRing.selectedKeyInfo?.id).not.toBe(first);

    const again = await connectAndSave(0, 2_500_000);
    expect(again).toBe(first);
    expect(await vaults()).toHaveLength(2);
    expect(await zcashWallets()).toHaveLength(2);
    expect(useStore.getState().keyRing.selectedKeyInfo?.id).toBe(first);
    // re-select also points the active zcash wallet at it
    const wallets = await zcashWallets();
    const activeIdx = await localExtStorage.get('activeZcashIndex');
    expect(wallets[activeIdx as number]!.vaultId).toBe(first);
    // a later birthday on re-import never raises the stored one
    expect(localMock.get(`zcashBirthday_${first}`)).toBe(2_000_000);
  });

  test('a different account on the same device is a second wallet', async () => {
    const a = await connectAndSave(0);
    const b = await connectAndSave(1);
    expect(a).not.toBe(b);
    const wallets = await zcashWallets();
    expect(wallets.map(w => w.ufvk).sort()).toEqual([UFVK_A, UFVK_B].sort());
  });

  test('re-import while the keyring is locked is refused, not silently unlocked', async () => {
    await useStore.getState().keyRing.setPassword('a-real-passw0rd');
    await connectAndSave(0);
    useStore.getState().keyRing.lock();
    await expect(connectAndSave(0)).rejects.toThrow('keyring locked');
    expect(useStore.getState().keyRing.status).not.toBe('unlocked');
  });

  test('legacy transparent-only ledger import keeps working (and still refuses duplicates)', async () => {
    const legacy = {
      address: 't1legacyaddress',
      transparentAddress: 't1legacyaddress',
      accountIndex: 0,
      deviceId: 'ledger-btc-t1legacyaddress',
      mainnet: true,
    };
    const id = await useStore
      .getState()
      .keyRing.addLedgerUnencrypted(legacy, 'ledger (transparent)');
    const [vault] = await vaults();
    expect(vault!.id).toBe(id);
    expect(vault!.insensitive['custody']).toBeUndefined();
    expect((await zcashWallets())[0]).toMatchObject({
      transparentAddress: 't1legacyaddress',
      orchardFvk: '',
    });
    await expect(useStore.getState().keyRing.addLedgerUnencrypted(legacy, 'again')).rejects.toThrow(
      'already imported',
    );
  });
});
