/**
 * FUND SAFETY: Ethermint chains (Injective, eth_secp256k1 / coin type 60) must
 * never be served over the Keplr provider - the shared coin-118 cosmos path
 * derives a plausible but unspendable `inj1` address. The guard runs before any
 * popup opens, and it must surface as a handled `{ok: false}` reply: the
 * listener returns its response over `sendResponse`, so a thrown error here
 * would reach the dapp as an unhandled rejection in the page's console instead
 * of a refused request.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { keplrMessageListener } from './keplr';

const sender = (origin: string): chrome.runtime.MessageSender => ({
  tab: { id: 1 } as chrome.tabs.Tab,
  frameId: 0,
  origin,
  url: `${origin}/index.html`,
  // real top-frame senders carry these; isValidExternalSender requires them
  documentLifecycle: 'active',
  documentId: 'doc-1',
});

let createMock: Mock;

const call = (req: unknown, s: chrome.runtime.MessageSender): Promise<unknown> =>
  new Promise(resolve => {
    const asyncResponse = keplrMessageListener(req, s, resolve);
    // the response is delivered later, over sendResponse
    expect(asyncResponse).toBe(true);
  });

beforeEach(() => {
  createMock = vi.fn(() => Promise.resolve({ id: 1 }));
  (globalThis.chrome as unknown as { windows: unknown }).windows = {
    create: createMock,
    getLastFocused: vi.fn(() => Promise.resolve({ id: 7, top: 0, left: 0, width: 800 })),
  };
});

describe('ZafuKeplr Ethermint guard', () => {
  const origin = 'https://dapp.example';

  it.each([
    ['enable', { chainIds: ['injective-1'] }],
    ['getKey', { chainId: 'injective-1' }],
    ['signDirect', { chainId: 'injective-1' }],
    ['signAmino', { chainId: 'injective-1' }],
    ['sendTx', { chainId: 'injective-1' }],
  ])('refuses %s on injective-1 as a handled failure', async (method, params) => {
    const res = await call({ type: 'ZafuKeplr', method, params, origin }, sender(origin));

    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toMatch(/Ethermint/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('refuses a mixed enable that includes an Ethermint chain', async () => {
    const res = await call(
      {
        type: 'ZafuKeplr',
        method: 'enable',
        params: { chainIds: ['noble-1', 'injective-1'] },
        origin,
      },
      sender(origin),
    );

    expect(res).toMatchObject({ ok: false });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('reports an unknown method as a handled failure, not a rejection', async () => {
    const res = await call(
      { type: 'ZafuKeplr', method: 'nonsense', params: {}, origin },
      sender(origin),
    );

    expect(res).toMatchObject({ ok: false, error: 'unsupported method nonsense' });
  });
});
