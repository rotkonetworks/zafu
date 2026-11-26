/**
 * Backup nudge: points unbacked phrase wallets at their recovery phrase,
 * and dismissing it hides only this visit without marking the phrase backed up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigate = vi.fn();
const storage = vi.hoisted(() => ({
  seedPhraseBackedUp: undefined as boolean | undefined,
  set: vi.fn(async (k: string, v: unknown) => {
    if (k === 'seedPhraseBackedUp') {
      storage.seedPhraseBackedUp = v as boolean;
    }
  }),
}));
const state = vi.hoisted(() => ({
  key: { id: 'v1', type: 'mnemonic' } as { id: string; type: string } | undefined,
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
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
  selectEffectiveKeyInfo: () => state.key,
}));

const { useBackupNudge } = await import('./notices');

const Probe = () => useBackupNudge();

describe('backup nudge', () => {
  let host: HTMLDivElement;
  let root: Root;

  const mount = async () => {
    await act(async () => root.render(<Probe />));
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

  it('points to the recovery phrase when unbacked', async () => {
    await mount();
    const action = [...host.querySelectorAll('button')].find(b => b.textContent === 'back up');
    expect(action).toBeDefined();
    act(() => action!.click());
    expect(navigate).toHaveBeenCalledWith('/settings/recovery-passphrase');
  });

  it('dismisses without marking the phrase backed up', async () => {
    await mount();
    const close = host.querySelector('button[aria-label="not now"]') as HTMLButtonElement;
    expect(close).not.toBeNull();
    act(() => close.click());
    expect(host.textContent).toBe('');
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.seedPhraseBackedUp).toBeUndefined();
  });

  it('stays hidden once backed up or for a hardware wallet', async () => {
    storage.seedPhraseBackedUp = true;
    await mount();
    expect(host.textContent).toBe('');

    storage.seedPhraseBackedUp = undefined;
    state.key = { id: 'z1', type: 'zigner-zafu' };
    await mount();
    expect(host.textContent).toBe('');
  });
});
