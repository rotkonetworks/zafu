/**
 * Recovery phrase screen: `?zigner=1` opens the existing "back up to zigner"
 * QR sheet once the password unlocks the phrase; cancelling before unlock
 * leaves seedPhraseBackedUp unset.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigate = vi.fn();
const search = { value: '' };
const storageSet = vi.fn();
const state = vi.hoisted(() => ({
  password: { isPassword: async (p: string) => p === 'correct' },
  keyRing: { keyInfos: [{ id: 'v1', name: 'Main', type: 'mnemonic' }] },
}));

vi.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams(search.value)],
  useNavigate: () => navigate,
  useLocation: () => ({ key: 'k1' }),
}));
vi.mock('@repo/storage-chrome/local', () => ({
  localExtStorage: { set: storageSet },
}));
vi.mock('../../../state', () => ({
  useStore: (sel: (s: unknown) => unknown) => sel(state),
}));
vi.mock('../../../state/password', () => ({
  passwordSelector: (s: typeof state) => s.password,
}));
vi.mock('../../../state/keyring', () => ({
  selectEffectiveKeyInfo: (s: typeof state) => s.keyRing.keyInfos[0],
  selectGetMnemonic: () => async () =>
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
}));
vi.mock('../../../components/qr-code', () => ({
  QrCode: ({ value }: { value: string }) => <div data-qr={value} />,
}));

const { SettingsPassphrase } = await import('./settings-passphrase');

describe('settings passphrase zigner backup deep link', () => {
  let host: HTMLDivElement;
  let root: Root;

  const unlock = async () => {
    const input = host.querySelector('input[type="password"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, 'correct');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const form = host.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(async () => Promise.resolve());
  };

  beforeEach(() => {
    search.value = '';
    storageSet.mockClear();
    navigate.mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
  });

  it('opens the zigner backup sheet straight after unlock when ?zigner=1', async () => {
    search.value = 'zigner=1';
    act(() => root.render(<SettingsPassphrase />));
    await unlock();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('back up to zigner');
    expect(dialog?.querySelector('[data-qr]')?.getAttribute('data-qr')).toContain('abandon');
    expect(storageSet).toHaveBeenCalledWith('seedPhraseBackedUp', true);
  });

  it('keeps the sheet closed without ?zigner=1 until requested', async () => {
    act(() => root.render(<SettingsPassphrase />));
    await unlock();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const btn = [...host.querySelectorAll('button')].find(
      b => b.textContent === 'back up to zigner',
    );
    act(() => btn!.click());
    expect(document.querySelector('[role="dialog"]')?.querySelector('[data-qr]')).not.toBeNull();
  });

  it('not now goes back without marking backed up', () => {
    search.value = 'zigner=1';
    act(() => root.render(<SettingsPassphrase />));
    const btn = [...host.querySelectorAll('button')].find(b => b.textContent === 'not now');
    act(() => btn!.click());
    expect(storageSet).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(-1);
  });
});
