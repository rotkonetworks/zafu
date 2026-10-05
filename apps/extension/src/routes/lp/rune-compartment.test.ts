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
import { lpStore, mayStopRune, refresh, refreshRune } from './store';

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
