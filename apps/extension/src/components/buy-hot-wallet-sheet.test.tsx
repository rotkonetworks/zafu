/**
 * Buy with a cold wallet selected: the sheet says why in place and no tab
 * opens; a phrase wallet that holds zcash can be picked from it; a phrase
 * wallet selected opens the buy page as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cold = { id: 'c', name: 'zigner', type: 'zigner-zafu', insensitive: {} };
const hot = { id: 'h', name: 'everyday', type: 'mnemonic', insensitive: {} };
const penumbraOnly = {
  id: 'p',
  name: 'penumbra only',
  type: 'mnemonic',
  insensitive: { supportedNetworks: ['penumbra'] },
};
const state = vi.hoisted(() => ({
  keyRing: {
    keyInfos: [] as { id: string; type: string }[],
    selectedKeyInfo: undefined as { id: string; type: string } | undefined,
    selectKeyRing: vi.fn(),
  },
}));
vi.mock('../state', () => {
  const useStore = (select: (s: unknown) => unknown) => select(state);
  useStore.getState = () => state;
  return { useStore };
});
vi.mock('../state/keyring', () => ({
  selectSwitcherKeyInfos: (s: typeof state) => s.keyRing.keyInfos,
}));
vi.mock('../config/beta', () => ({ betaFeatures: () => true }));

const { BuyHotWalletSheet } = await import('./buy-hot-wallet-sheet');
const { openBuyPage, resumeBuyPage } = await import('../buy/open');

describe('buy with a cold wallet', () => {
  let root: Root;
  const create = vi.fn();
  beforeEach(() => {
    (globalThis.chrome as unknown as { tabs: unknown }).tabs = { create };
    (chrome.runtime as { getURL?: (p: string) => string }).getURL = p =>
      `chrome-extension://${chrome.runtime.id}/${p}`;
    state.keyRing.keyInfos = [cold, hot, penumbraOnly];
    state.keyRing.selectKeyRing = vi.fn((id: string) => {
      state.keyRing.selectedKeyInfo = state.keyRing.keyInfos.find(k => k.id === id);
      return Promise.resolve();
    });
    root = createRoot(document.body.appendChild(document.createElement('div')));
    act(() => root.render(createElement(BuyHotWalletSheet)));
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    create.mockClear();
  });
  const buttons = () => [...document.querySelectorAll('button')].map(b => b.textContent);

  it('explains in a sheet and opens no tab', () => {
    state.keyRing.selectedKeyInfo = cold;
    act(() => openBuyPage());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'buying needs a phrase wallet',
    );
    expect(buttons()).toContain('use everyday');
    expect(buttons()).not.toContain('use penumbra only');
    expect(create).not.toHaveBeenCalled();
  });

  it('switches to the phrase wallet picked, then opens the buy page', async () => {
    state.keyRing.selectedKeyInfo = cold;
    act(() => openBuyPage());
    await act(async () =>
      [...document.querySelectorAll('button')].find(b => b.textContent === 'use everyday')!.click(),
    );
    expect(state.keyRing.selectKeyRing).toHaveBeenCalledWith('h');
    expect(create).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('carries on a started buy without offering another wallet', () => {
    state.keyRing.selectedKeyInfo = cold;
    act(() => resumeBuyPage());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('says so in the sheet when switching wallets fails, and opens nothing', async () => {
    state.keyRing.selectedKeyInfo = cold;
    state.keyRing.selectKeyRing = vi.fn(() => Promise.reject(new Error('locked')));
    act(() => openBuyPage());
    await act(async () =>
      [...document.querySelectorAll('button')].find(b => b.textContent === 'use everyday')!.click(),
    );
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'zafu could not switch wallets',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('opens the buy page for a phrase wallet', () => {
    state.keyRing.selectedKeyInfo = hot;
    act(() => openBuyPage());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
  });
});
