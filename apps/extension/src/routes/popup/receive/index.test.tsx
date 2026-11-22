/**
 * Receive screen: reminds unbacked phrase wallets before they hand out an
 * address, pointing at the zigner backup flow; dismissing hides only now.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigate = vi.fn();
const storage = vi.hoisted(() => ({
  seedPhraseBackedUp: undefined as boolean | undefined,
  set: vi.fn(),
}));
const state = vi.hoisted(() => ({
  key: { id: 'v1', type: 'mnemonic' } as { id: string; type: string } | undefined,
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useLocation: () => ({ key: 'k1', search: '', state: null }),
}));
vi.mock('@repo/storage-chrome/local', () => ({
  localExtStorage: {
    get: async (k: string) => (k === 'seedPhraseBackedUp' ? storage.seedPhraseBackedUp : undefined),
    set: storage.set,
  },
}));
vi.mock('../../../state', () => ({
  useStore: (sel: (s: unknown) => unknown) => sel({}),
}));
vi.mock('../../../state/keyring', () => ({
  selectActiveNetwork: () => 'zcash',
  selectEffectiveKeyInfo: () => state.key,
}));
vi.mock('../../../state/wallets', () => ({
  selectActiveZcashWallet: () => undefined,
}));
vi.mock('../../../hooks/use-address', () => ({
  useActiveAddress: () => ({ address: 'u1addr', loading: false, shieldedIndex: '0' }),
}));
vi.mock('../../../state/shielded-receive-index', () => ({
  rotateShieldedDiversifier: async () => '0',
}));
vi.mock('../../../transparent/penumbra-routes', () => ({
  usePenumbraRoutes: () => [],
  routeForChain: () => undefined,
}));
vi.mock('../../../config/networks', () => ({
  getActiveIbcSubnetworks: () => [],
}));
vi.mock('./receive-tab', () => ({
  ZcashReceive: () => <div data-testid='receive-body'>receive body</div>,
  PenumbraReceive: () => <div />,
  PlainReceive: () => <div />,
}));
vi.mock('./transparent-receive', () => ({
  TransparentReceive: () => <div />,
}));
vi.mock('../send/send-fields', () => ({
  PickSheet: () => null,
}));

const { ReceivePage } = await import('./index');

describe('receive backup reminder', () => {
  let host: HTMLDivElement;
  let root: Root;

  const mount = async () => {
    await act(async () => root.render(<ReceivePage />));
    await act(async () => Promise.resolve());
  };

  beforeEach(() => {
    storage.seedPhraseBackedUp = undefined;
    storage.set.mockClear();
    navigate.mockClear();
    state.key = { id: 'v1', type: 'mnemonic' };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('reminds unbacked phrase wallets on receive and opens the zigner backup flow', async () => {
    await mount();
    expect(host.textContent).toContain("your recovery phrase isn't backed up yet");
    const action = [...host.querySelectorAll('button')].find(
      b => b.textContent === 'back up to zigner',
    );
    expect(action).toBeDefined();
    act(() => action!.click());
    expect(navigate).toHaveBeenCalledWith('/settings/recovery-passphrase?zigner=1');
  });

  it('dismisses without marking backed up', async () => {
    await mount();
    const close = host.querySelector('button[aria-label="not now"]') as HTMLButtonElement;
    act(() => close.click());
    expect(host.textContent).not.toContain("your recovery phrase isn't backed up yet");
    expect(storage.set).not.toHaveBeenCalled();
  });

  it('does not remind once backed up', async () => {
    storage.seedPhraseBackedUp = true;
    await mount();
    expect(host.textContent).not.toContain("your recovery phrase isn't backed up yet");
  });
});
