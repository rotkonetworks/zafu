import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../state/keyring/network-worker', () => ({
  // the run waits on its first plan: these tests only ask whether it started
  planTransparentDepositInWorker: () => new Promise(() => undefined),
  chainTipInWorker: vi.fn(),
  lookupTxInWorker: vi.fn(),
}));

import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { create } from 'zustand';
import { AllSlices, initializeStore } from '../../state';
import { isOpenPayment, openPayments, type OpenPayment } from './open-payments';
import { resumePayment } from './run';
import { isRunning } from './via-fresh';

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;
const sessionMock = (chrome.storage.session as unknown as { mock: Map<string, unknown> }).mock;

const TEX = 'textest1glfs7yuku4mx57vxs9qerv0307lazcpefxxxx';
const payment = (over: Partial<OpenPayment> = {}): OpenPayment => ({
  v: 1,
  id: `p-${Math.random()}`,
  wallet: 'vault#1',
  at: 1,
  req: {
    tAddress: 'tmFreshAddressxxxxxxxxxxxxxxxxxxxx',
    tIndex: 21,
    to: TEX,
    amountZat: '110000000',
    memo: '',
    mainnet: false,
    reviewedFee: '10000',
  },
  ...over,
});

/** the store facts resume reads, as a testnet hot wallet on pocket store `vault#1` */
const state = (mainnet: boolean, store = 'vault#1') =>
  ({
    keyRing: {
      selectedKeyInfo: { id: 'vault', type: 'mnemonic' },
      getVaultUnlock: vi.fn(),
    },
    __store: store,
    __mainnet: mainnet,
  }) as unknown as AllSlices;

vi.mock('../../state/pockets', async orig => ({
  ...(await orig<object>()),
  activeZcashStoreId: (s: { __store: string }) => s.__store,
  activeAccountIndex: () => 0,
}));
vi.mock('../../state/wallets', async orig => ({
  ...(await orig<object>()),
  selectZcashIsMainnet: (s: { __mainnet: boolean }) => s.__mainnet,
  selectActiveZcashWallet: () => undefined,
}));
vi.mock('./legs', async orig => ({
  ...(await orig<object>()),
  legContextOf: () => ({
    storeId: 'vault#1',
    walletId: 'vault',
    pocket: 0,
    zidecarUrl: 'https://node',
    cold: false,
    legsPerUnlock: 2,
    getVaultUnlock: vi.fn(),
  }),
}));

describe('an open payment', () => {
  beforeEach(async () => {
    localMock.clear();
    sessionMock.clear();
    const useStore = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
    await useStore.getState().keyRing.setPassword('s0meUs3rP@ssword');
  });

  test('is sealed at rest and read back whole', async () => {
    const p = payment();
    expect(await openPayments.save(p)).toBe(true);
    const raw = JSON.stringify(localMock.get('openPayments'));
    expect(raw).toContain('encrypted');
    expect(raw).not.toContain(TEX);
    expect(raw).not.toContain('tmFresh');
    expect(await openPayments.read()).toEqual([p]);
    await openPayments.patch(p.id, { moveTxid: 'aa'.repeat(32) });
    expect((await openPayments.read())[0]?.moveTxid).toBe('aa'.repeat(32));
    await openPayments.forget(p.id);
    expect(await openPayments.read()).toEqual([]);
    expect(isOpenPayment({ ...p, req: undefined })).toBe(false);
  });

  test('resumes on its own pocket and network only: a testnet tex resumes on testnet', () => {
    const other = payment();
    resumePayment(other, state(true));
    expect(isRunning(other.id)).toBe(false);
    resumePayment(other, state(false, 'vault#2'));
    expect(isRunning(other.id)).toBe(false);
    const mine = payment();
    resumePayment(mine, state(false));
    expect(isRunning(mine.id)).toBe(true);
  });
});
