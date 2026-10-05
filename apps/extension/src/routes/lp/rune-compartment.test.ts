/**
 * The founder's rule for rune on lp.html: nothing about a thorchain account
 * exists for a pocket that never chose "add with rune too". No derivation,
 * no storage key, no request; and a page that did opt in reads its rune side
 * only through the thornode destination.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const view = vi.hoisted(() => ({ on: new Set(['thorchain', 'midgard', 'near-swap']) }));
vi.mock('../../net/egress-opt-in', () => ({
  readEgressView: () =>
    Promise.resolve(
      ['thorchain', 'midgard', 'near-swap'].map(id => ({
        id,
        on: view.on.has(id),
        why: view.on.has(id) ? 'you-allowed' : 'default-off',
      })),
    ),
}));
vi.mock('../../state/swap/near', () => ({
  nearPrices: () => Promise.resolve(new Map([['ZEC@zec', 1300]])),
}));
const worker = vi.hoisted(() => ({
  thorAddressInWorker: vi.fn(async () => 'thor1zf3gsk7edzwl9syyefvfhle37cjtql35nd8hd7'),
  signThorDepositInWorker: vi.fn(async () => 'AAAA'),
}));
vi.mock('../../state/keyring/network-worker', () => ({
  ...worker,
  buildSendTxInWorker: vi.fn(),
  getPoolBalancesInWorker: vi.fn(async () => ({ total: 0n })),
  getTransparentUtxosInWorker: vi.fn(async () => []),
  planTransparentDepositInWorker: vi.fn(),
  sendTransparentDepositInWorker: vi.fn(),
  shieldInWorker: vi.fn(),
  spawnNetworkWorker: vi.fn(async () => undefined),
}));

import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { create } from 'zustand';
import { AllSlices, initializeStore } from '../../state';
import { changeLp, exportLpRune, readLpPocket } from '../../lp/store';
import { HALF_WAITING_LINE, lpStore, mayStopRune, refresh, refreshRune, startAdd2 } from './store';

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;
const sessionMock = (chrome.storage.session as unknown as { mock: Map<string, unknown> }).mock;
const LP = 't1SS4bxPM3ogU4USyHvzheVQDWa7Gbztz4p';
const THOR1 = 'thor1zf3gsk7edzwl9syyefvfhle37cjtql35nd8hd7';

const urls: string[] = [];
const realFetch = globalThis.fetch;

beforeEach(async () => {
  localMock.clear();
  sessionMock.clear();
  urls.length = 0;
  worker.thorAddressInWorker.mockClear();
  worker.signThorDepositInWorker.mockClear();
  const useStore = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
  await useStore.getState().keyRing.setPassword('s0meUs3rP@ssword');
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;
  lpStore.setState({
    phase: 'ready',
    intro: null,
    egress: { thornode: true, midgard: true, prices: true },
    storeId: 'vault-a',
    lp: { index: 21, address: LP },
    rune: undefined,
    runeRead: undefined,
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const settle = () => new Promise(r => setTimeout(r, 50));

describe('a pocket that never chose rune', () => {
  it('derives nothing, stores nothing and asks no cosmos endpoint, on a full refresh', async () => {
    await changeLp(() => ({ 'vault-a': { index: 21, address: LP } }));
    const before = JSON.stringify([...localMock.entries()].filter(([k]) => k !== 'zecLp'));
    await refresh();
    await refreshRune();
    await settle();
    // the pool was read: the page works as before
    expect(urls.some(u => u.includes('/thorchain/pool/ZEC.ZEC'))).toBe(true);
    // nothing about a rune account
    expect(urls.filter(u => u.includes('/cosmos/'))).toEqual([]);
    expect(urls.filter(u => u.includes('thor1'))).toEqual([]);
    expect(worker.thorAddressInWorker).not.toHaveBeenCalled();
    expect(worker.signThorDepositInWorker).not.toHaveBeenCalled();
    // no counter, no rune record, nothing in the backup
    expect(localMock.get('cosmosChainCounters')).toBeUndefined();
    expect((await readLpPocket('vault-a'))?.rune).toBeUndefined();
    expect(await exportLpRune(() => 'zid-a')).toBeUndefined();
    expect(JSON.stringify([...localMock.entries()].filter(([k]) => k !== 'zecLp'))).toBe(before);
    expect(mayStopRune(lpStore.getState())).toBe(false);
  });

  it('a rune choice that was turned off reads nothing either', async () => {
    lpStore.setState({ rune: { index: 3, on: false } });
    await refreshRune();
    await refresh();
    await settle();
    expect(urls.filter(u => u.includes('/cosmos/'))).toEqual([]);
    expect(worker.thorAddressInWorker).not.toHaveBeenCalled();
  });
});

describe('a pocket that chose rune', () => {
  it('reads its thor1 through the thornode gateway, and only while thornode is on', async () => {
    lpStore.setState({ rune: { index: 3, on: true, address: THOR1 } });
    await refreshRune();
    const cosmos = urls.filter(u => u.includes('/cosmos/'));
    expect(cosmos.length).toBeGreaterThan(0);
    for (const u of cosmos) {
      expect(u.startsWith('https://gateway.liquify.com/chain/thorchain_api/cosmos/')).toBe(true);
      expect(u).toContain(THOR1);
    }
    urls.length = 0;
    lpStore.setState({ egress: { thornode: false, midgard: true, prices: true } });
    view.on.delete('thorchain');
    await refreshRune();
    expect(urls).toEqual([]);
    view.on.add('thorchain');
  });
});

describe('an add while a half already waits', () => {
  it('is refused, so the new zec never pairs with the old half', async () => {
    await changeLp(() => ({
      'vault-a': { index: 21, address: LP, rune: { index: 3, on: true, address: THOR1 } },
    }));
    const pool = { asset: 2_349_956_151n, rune: 4_115_368_117_505n, units: 3_902_179_720_724n };
    lpStore.setState({
      rune: { index: 3, on: true, address: THOR1 },
      amt: '0.01',
      shieldedZat: 100_000_000n,
      thor: {
        pool: { ...pool, status: 'Available', tradingHalted: false, pendingRune: 0n, zecUsd: 1 },
      } as never,
      runeRead: {
        at: 0,
        address: THOR1,
        balance: 1_000_000_000_000n,
        fee: 2_000_000n,
        account: { accountNumber: '1', sequence: '0' },
        paired: {
          units: 0n,
          pendingRune: 173_400_000n,
          pendingAsset: 0n,
          runeAddress: THOR1,
          assetAddress: LP,
          depositAsset: 0n,
          depositRune: 0n,
          lastAddHeight: 1,
          luviGrowthPct: 0,
        },
      },
      flight: undefined,
      error: undefined,
    });
    await startAdd2();
    expect(lpStore.getState().error).toBe(HALF_WAITING_LINE);
    expect((await readLpPocket('vault-a'))?.flight).toBeUndefined();
    expect(worker.signThorDepositInWorker).not.toHaveBeenCalled();
  });
});
