import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// the screen reads the store through selectors; each test hands it a state
let state: unknown;
vi.mock('../../../state', () => ({
  useStore: (select: (s: unknown) => unknown) => select(state),
}));
vi.mock('../../../state/keyring', () => ({
  selectEnabledNetworks: (s: { keyRing: { enabledNetworks: string[] } }) =>
    s.keyRing.enabledNetworks,
  selectEffectiveKeyInfo: () => undefined,
}));
// local sync progress and the rescan service are the worker's; none of it is under test
vi.mock('../../../hooks/zcash-sync', () => ({
  useZcashChainCheck: () => undefined,
  useZcashWorkerSync: () => ({ workerSyncHeight: 0, workerChainHeight: 0 }),
}));
vi.mock('../../../services/zcash-resync', () => ({ rescanZcash: vi.fn() }));
vi.mock('../../../state/keyring/endpoint-latency', () => ({ measurePresetLatencies: vi.fn() }));
vi.mock('./node-sheet', () => ({ NodeSheet: () => null }));
vi.mock('../../../utils/navigate', () => ({ usePopupNav: () => () => undefined }));
vi.mock('./settings-screen', () => ({
  SettingsScreen: ({ children }: { children: unknown }) => children,
  Section: ({ children }: { children: unknown }) => children,
}));

import { DEFAULT_PRIVACY_SETTINGS } from '../../../state/privacy';
import { SettingsZcashNetwork } from './settings-zcash-network';

const setup = (enabledNetworks: string[], backend: 'zidecar' | 'lightwalletd') => {
  state = {
    privacy: { settings: DEFAULT_PRIVACY_SETTINGS, setSetting: vi.fn() },
    keyRing: { enabledNetworks, activeNetwork: 'penumbra' },
    networks: {
      networks: { zcash: { backend } },
      setMemoSyncStrategy: vi.fn(),
      setMempoolWatch: vi.fn(),
      setNetworkEndpoint: vi.fn(),
    },
  };
};

const toggle = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

describe('the zcash screen follows the enabled networks, not the active wallet', () => {
  let root: Root;
  const render = async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(MemoryRouter, null, createElement(SettingsZcashNetwork)));
      await Promise.resolve();
    });
  };
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
  });

  it('shows what the node learns with a penumbra wallet active while zcash is on', async () => {
    setup(['penumbra', 'zcash'], 'zidecar');
    await render();
    const text = document.body.textContent ?? '';
    expect(text).toContain('check transparent each block');
    expect(text).toContain('memo decoys');
    expect(text).toContain('voting servers');
  });

  it('while zcash is off: no zcash rows, and history stays reachable', async () => {
    setup(['penumbra'], 'zidecar');
    await render();
    const text = document.body.textContent ?? '';
    expect(text).toContain('zcash is off');
    expect(text).toContain('keep history on this computer');
    expect(text).not.toContain('memo decoys');
    expect(text).not.toContain('explorer links');
  });

  it('shows memo decoys and payments before mining switched off on a lightwalletd node', async () => {
    setup(['zcash'], 'lightwalletd');
    await render();
    for (const label of ['memo decoys', "see payments before they're mined"]) {
      const el = toggle(label);
      expect(el?.disabled, label).toBe(true);
      expect(el?.parentElement?.textContent).toContain('needs a zidecar node');
    }
  });
});
