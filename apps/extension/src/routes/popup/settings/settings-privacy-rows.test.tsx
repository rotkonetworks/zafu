import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// the screen reads the store through selectors; each test hands it a state
let state: unknown;
vi.mock('../../../state', () => ({
  useStore: (select: (s: unknown) => unknown) => select(state),
}));
vi.mock('../../../state/keyring', () => ({
  selectEnabledNetworks: (s: { keyRing: { enabledNetworks: string[] } }) =>
    s.keyRing.enabledNetworks,
}));
vi.mock('@repo/storage-chrome/local', () => ({
  localExtStorage: { get: async () => undefined, set: async () => undefined },
}));
vi.mock('../../../services/zcashme/config', () => ({
  readZcashMeConfig: async () => ({ mode: 'off' }),
  useZcashMeMode: () => 'off',
}));
vi.mock('../../../utils/navigate', () => ({ usePopupNav: () => () => undefined }));
vi.mock('./settings-screen', () => ({
  SettingsScreen: ({ children }: { children: unknown }) => children,
  Section: ({ children }: { children: unknown }) => children,
}));

import { DEFAULT_PRIVACY_SETTINGS } from '../../../state/privacy';
import { SettingsPrivacy } from './settings-privacy';

const setup = (enabledNetworks: string[], backend: 'zidecar' | 'lightwalletd') => {
  state = {
    privacy: { settings: DEFAULT_PRIVACY_SETTINGS, setSetting: vi.fn() },
    keyRing: { enabledNetworks, activeNetwork: 'penumbra' },
    networks: {
      networks: { zcash: { backend } },
      setMemoSyncStrategy: vi.fn(),
      setMempoolWatch: vi.fn(),
    },
    connectedSites: { knownSites: [] },
  };
};

/** a toggle by its label, and the row it sits in */
const toggle = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

describe('privacy rows follow the enabled networks, not the active wallet', () => {
  let root: Root;
  const render = async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(SettingsPrivacy));
      await Promise.resolve();
    });
  };
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
  });

  it('shows the zcash rows with a penumbra wallet active while zcash is on', async () => {
    setup(['penumbra', 'zcash'], 'zidecar');
    await render();
    const text = document.body.textContent ?? '';
    expect(text).toContain('zcash: transparent each block');
    expect(text).toContain('zcash: memo decoys');
    expect(text).toContain('zcash.me');
  });

  it('hides them while zcash is off', async () => {
    setup(['penumbra'], 'zidecar');
    await render();
    expect(document.body.textContent).not.toContain('zcash:');
  });

  it('shows memo decoys and instant pending switched off on a lightwalletd node', async () => {
    setup(['zcash'], 'lightwalletd');
    await render();
    for (const label of ['zcash: memo decoys', 'zcash: instant pending']) {
      const el = toggle(label);
      expect(el?.disabled, label).toBe(true);
      expect(el?.parentElement?.textContent).toContain('needs a zidecar node');
    }
  });
});
