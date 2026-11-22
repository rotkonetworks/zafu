import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let state: unknown;
vi.mock('../../../state', () => ({
  useStore: (select: (s: unknown) => unknown) => select(state),
}));
vi.mock('../../../state/keyring', () => ({
  keyRingSelector: (s: { keyRing: unknown }) => s.keyRing,
  selectEnabledNetworks: () => ['penumbra'],
  selectEffectiveKeyInfo: () => undefined,
}));
vi.mock('../../../state/keyring/vault-ops', () => ({ keyInfoSupportsNetwork: () => true }));
vi.mock('../../../state/wallets', () => ({
  walletsSelector: () => ({ all: [], zcashWallets: [] }),
}));
const { openPageInTab } = vi.hoisted(() => ({ openPageInTab: vi.fn() }));
vi.mock('../../../utils/popup-detection', () => ({ openPageInTab }));
vi.mock('../../../utils/navigate', () => ({ usePopupNav: () => () => undefined }));
vi.mock('./settings-screen', () => ({
  SettingsScreen: ({ children }: { children: unknown }) => children,
  Section: ({ children }: { children: unknown }) => children,
}));

import { PagePath } from '../../page/paths';
import { SettingsWallets } from './settings-wallets';

describe('settings > wallets: import a recovery phrase', () => {
  let root: Root;
  const render = async (types: string[]) => {
    state = {
      keyRing: {
        keyInfos: types.map((type, i) => ({
          id: `${i}`,
          name: type,
          type,
          insensitive: type === 'mnemonic' ? {} : { supportedNetworks: ['zcash'] },
        })),
      },
    };
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(MemoryRouter, null, createElement(SettingsWallets)));
      await Promise.resolve();
    });
  };
  const row = (label = 'import a recovery phrase') =>
    [...document.querySelectorAll<HTMLElement>('button, [role="button"]')].find(el =>
      el.textContent?.includes(label),
    );
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    openPageInTab.mockClear();
  });

  it('opens the import screen, not the apps page, beside a cold wallet', async () => {
    await render(['zigner-zafu']);
    act(() => row()?.click());
    expect(openPageInTab).toHaveBeenCalledWith(PagePath.IMPORT_SEED_PHRASE, true);
  });

  it('opens beside a phrase wallet, as a second wallet for each network', async () => {
    await render(['mnemonic']);
    act(() => row()?.click());
    expect(openPageInTab).toHaveBeenCalledWith(PagePath.IMPORT_SEED_PHRASE, true);
  });

  it('greys out and says why once a network has two wallets', async () => {
    await render(['zigner-zafu', 'mnemonic']);
    expect(row()?.textContent).toContain('zafu holds up to two zcash wallets');
    act(() => row()?.click());
    expect(openPageInTab).not.toHaveBeenCalled();
    // penumbra still has room, so a signer can still be scanned
    expect(row('scan a signer')?.textContent).toContain('zigner, keystone');
  });

  it('greys out scanning only once every network has two wallets', async () => {
    await render(['mnemonic', 'mnemonic']);
    expect(row('scan a signer')?.textContent).toContain(
      'zafu holds up to two zcash and penumbra wallets',
    );
  });
});
