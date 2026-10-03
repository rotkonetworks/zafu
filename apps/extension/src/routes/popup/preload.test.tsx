import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient } from '@tanstack/react-query';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// the egress table: whatever a test says is allowed right now
const allowed = new Set<string>();
vi.mock('../../net/egress', () => ({
  checkEgress: (url: string) => ({ allow: allowed.has(new URL(url).host) }),
}));
// a preload never asks to allow anything
const askOptIn = vi.fn();
vi.mock('../../net/egress-opt-in', () => ({ requestEgressOptIn: askOptIn }));
// the worker's history read is what asks the light-client server
const getHistory = vi.fn(async () => []);
const getBalance = vi.fn(async () => '0');
vi.mock('../../state/keyring/network-worker', () => ({
  getHistoryInWorker: getHistory,
  getBalanceInWorker: getBalance,
  getPoolBalancesInWorker: vi.fn(async () => ({})),
  getPoolNotesInWorker: vi.fn(async () => ({ orchard: [], ironwood: [] })),
  getPendingSendsInWorker: vi.fn(async () => []),
}));

const keyInfo = { id: 'w1', type: 'mnemonic', label: 'w', networks: ['zcash'], insensitive: {} };
const state = {
  keyRing: {
    activeNetwork: 'zcash',
    penumbraAccount: 0,
    keyInfos: [keyInfo],
    selectedKeyInfo: keyInfo,
    enabledNetworks: ['zcash'],
    getMnemonic: vi.fn(),
  },
  pockets: {
    book: {
      w1: {
        active: 0,
        pockets: [
          { account: 0, name: 'main' },
          { account: 1, name: 'rent' },
          { account: 2, name: 'old', hidden: true },
        ],
      },
    },
  },
  wallets: { zcashWallets: [], activeZcashIndex: 0 },
  privacy: { settings: { enableTransactionHistory: true } },
  networks: { networks: { zcash: { endpoint: 'https://zcash.rotko.net' } } },
};
vi.mock('../../state', () => ({ useStore: { getState: () => state } }));

const { installPreload, intentHandlers, preloadTarget, registerRoutePreload } =
  await import('./preload');
const { routePreloads } = await import('./route-preloads');

const fetchSpy = vi.fn(() => Promise.reject(new Error('no network in tests')));
let root: Root;
let host: HTMLDivElement;
let visibility: DocumentVisibilityState = 'visible';

/** a nav item to `to` inside the layout's delegated intent listener */
const renderNav = (to: string) => {
  act(() =>
    root.render(
      <div {...intentHandlers}>
        <button type='button' data-preload={to}>
          <span id='inner'>go</span>
        </button>
      </div>,
    ),
  );
  return host.querySelector('#inner')!;
};
const press = (el: Element) =>
  act(() => void el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
const hover = (el: Element) =>
  act(() => void el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
const settle = () => act(() => new Promise(r => setTimeout(r, 20)));

let client: QueryClient;
let seq = 0;
let registered = false;

beforeEach(() => {
  allowed.clear();
  getHistory.mockClear();
  getBalance.mockClear();
  askOptIn.mockClear();
  fetchSpy.mockClear();
  visibility = 'visible';
  vi.stubGlobal('fetch', fetchSpy);
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  // storage holds the pocket's transparent addresses already (local only)
  const tAddrs = Array.from({ length: 40 }, (_, i) => `t1fake${i}`);
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (k: string) => (k === 'zcashTAddrs:w1' ? { [k]: tAddrs } : {})),
        set: vi.fn(async () => undefined),
      },
    },
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // a fresh path per test, so the once-per-window rule never leaks between tests
  seq++;
  installPreload({
    client,
    routes: [
      { path: `/activity${seq}`, handle: { preload: routePreloads.activity } },
      { path: `/home${seq}`, handle: { preload: routePreloads.home } },
    ],
  });
  if (!registered) {
    registered = true;
    registerRoutePreload('sheet:wallets', routePreloads.wallets);
  }
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('intent preloading', () => {
  it('pressing toward a screen whose server is not allowed asks it nothing', async () => {
    press(renderNav(`/activity${seq}`));
    await settle();
    expect(getHistory).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(askOptIn).not.toHaveBeenCalled();
  });

  it('the same press reads history once the server is allowed (the test is not vacuous)', async () => {
    allowed.add('zcash.rotko.net');
    press(renderNav(`/activity${seq}`));
    await settle();
    expect(getHistory).toHaveBeenCalledTimes(1);
    expect(askOptIn).not.toHaveBeenCalled();
  });

  it('hovering only counts on a hover-capable pointer (none in tests): nothing runs', async () => {
    allowed.add('zcash.rotko.net');
    hover(renderNav(`/activity${seq}`));
    await settle();
    expect(getHistory).not.toHaveBeenCalled();
  });

  it('nothing runs while zafu is hidden', async () => {
    allowed.add('zcash.rotko.net');
    visibility = 'hidden';
    press(renderNav(`/activity${seq}`));
    await settle();
    expect(getHistory).not.toHaveBeenCalled();
  });

  it('home warms local reads only: no fetch, no ask, and history only where allowed', async () => {
    press(renderNav(`/home${seq}`));
    await settle();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(askOptIn).not.toHaveBeenCalled();
    expect(getHistory).not.toHaveBeenCalled();
    expect(client.getQueryData(['zcashWorker', 'w1', 'balance'])).toBe(0n);
  });

  it('opening the wallets panel warms every listed pocket, locally, so a switch is instant', async () => {
    press(renderNav('sheet:wallets'));
    await settle();
    expect(getBalance.mock.calls.map(c => (c as unknown[])[1]).sort()).toEqual(
      ['w1', 'w1#1'].sort(),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(client.getQueryData(['zcashWorker', 'w1#1', 'balance'])).toBe(0n);
  });

  it('fires once per target per window, and runs registered preloads beside the route', async () => {
    const extra = vi.fn();
    const off = registerRoutePreload(`/activity${seq}`, extra);
    const el = renderNav(`/activity${seq}`);
    press(el);
    press(el);
    await settle();
    expect(extra).toHaveBeenCalledTimes(1);
    off();
    preloadTarget(`sheet:x${seq}`);
    expect(extra).toHaveBeenCalledTimes(1);
  });
});
