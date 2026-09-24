/**
 * zafu_open_shield: a dapp asks the wallet to show its own shield screen.
 * Gated on a top-frame sender, a supported chain and the `connect`
 * capability; one wallet window per site at a time.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { externalMessageListener } from './external-easteregg';
import { grantCapability } from '@repo/storage-chrome/origin';

const sender = (origin: string, frameId = 0): chrome.runtime.MessageSender => ({
  tab: { id: 1 } as chrome.tabs.Tab,
  frameId,
  origin,
  url: `${origin}/index.html`,
  // real top-frame senders carry these; isValidExternalSender requires them
  documentLifecycle: 'active',
  documentId: 'doc-1',
});

const call = (req: unknown, s: chrome.runtime.MessageSender): Promise<unknown> =>
  new Promise(resolve => {
    externalMessageListener(req, s, resolve);
  });

let createMock: Mock;

beforeEach(() => {
  (globalThis.chrome.runtime as unknown as { getURL: unknown }).getURL = (p: string) =>
    `chrome-extension://test${p}`;
  // no side panel open anywhere -> the popup path
  (globalThis.chrome.runtime as unknown as { getContexts: unknown }).getContexts = vi.fn(() =>
    Promise.resolve([]),
  );
  createMock = vi.fn(() => Promise.resolve({ id: Math.floor(Math.random() * 1e6) }));
  (globalThis.chrome as unknown as { windows: unknown }).windows = {
    create: createMock,
    getLastFocused: vi.fn(() => Promise.resolve({ id: 7 })),
    onRemoved: { addListener: vi.fn() },
  };
});

describe('zafu_open_shield', () => {
  it('opens the wallet shield screen for a connected site', async () => {
    const origin = 'https://veil-open.example';
    await grantCapability(origin, 'connect');
    const res = await call({ type: 'zafu_open_shield', chainId: 'injective' }, sender(origin));
    expect(res).toEqual({ opened: true });
    expect(createMock).toHaveBeenCalledTimes(1);
    const { url } = (createMock.mock.calls[0] as [{ url: string }])[0];
    expect(url).toBe('chrome-extension://test/popup.html#/receive?mode=shield');
  });

  it('refuses a site without the connect capability', async () => {
    const res = await call(
      { type: 'zafu_open_shield', chainId: 'injective' },
      sender('https://stranger.example'),
    );
    expect(res).toMatchObject({ code: 'denied' });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('refuses an iframe sender (provenance spoofing)', async () => {
    const origin = 'https://framed.example';
    await grantCapability(origin, 'connect');
    const res = await call({ type: 'zafu_open_shield', chainId: 'injective' }, sender(origin, 3));
    expect(res).toMatchObject({ code: 'denied' });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('rejects chains it cannot shield from', async () => {
    const origin = 'https://wrong-chain.example';
    await grantCapability(origin, 'connect');
    const res = await call({ type: 'zafu_open_shield', chainId: 'osmosis' }, sender(origin));
    expect(res).toMatchObject({ code: 'invalid_request' });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('opens at most one window per site at a time', async () => {
    const origin = 'https://spammy.example';
    await grantCapability(origin, 'connect');
    await call({ type: 'zafu_open_shield', chainId: 'injective' }, sender(origin));
    const second = await call({ type: 'zafu_open_shield', chainId: 'injective' }, sender(origin));
    expect(second).toMatchObject({ code: 'rate_limited' });
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});
