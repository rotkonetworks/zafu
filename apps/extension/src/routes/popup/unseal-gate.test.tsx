/**
 * The password gate follows what an action unseals, never the selected
 * wallet: with a zigner selected, anything that opens a multisig share still
 * asks for the password, and nothing of the share is read before it does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const zigner = { id: 'z', type: 'zigner-zafu', name: 'zigner', insensitive: {} };
const shareVault = { id: 'm', type: 'frost-multisig', name: 'group', insensitive: {} };
const seat = {
  id: 'w',
  label: 'group seat',
  vaultId: 'm',
  orchardFvk: 'uview',
  mainnet: true,
  multisig: { threshold: 2, maxSigners: 3, custody: 'local', backedUpAt: 1 },
};
const getMultisigSecrets = vi.fn();
const state = {
  keyRing: {
    keyInfos: [zigner, shareVault],
    selectedKeyInfo: zigner,
    newFrostMultisigKey: vi.fn(),
    getMultisigSecrets,
  },
  frostSession: { resetDkg: vi.fn() },
  wallets: { zcashWallets: [seat] },
};
vi.mock('../../state', () => ({
  useStore: (selector: (s: unknown) => unknown) => selector(state),
}));
vi.mock('../../state/password', () => ({ passwordSelector: () => ({ isPassword: vi.fn() }) }));
vi.mock('../../state/keyring', () => ({
  selectKeyInfos: (s: typeof state) => s.keyRing.keyInfos,
  selectEffectiveKeyInfo: (s: typeof state) => s.keyRing.selectedKeyInfo,
}));
vi.mock('../../state/wallets', () => ({
  selectMultisigWallets: (s: typeof state) => s.wallets.zcashWallets,
}));
vi.mock('../../state/keyring/network-worker', () => ({}));
vi.mock('../../state/keyring/frostd-relay-client', () => ({ FrostdRelayClient: vi.fn() }));
vi.mock('../../state/keyring/relay-identity', () => ({}));
vi.mock('./multisig/backup/backup-modal', () => ({ BackupModal: () => null }));
vi.mock('./multisig/backup/import-modal', () => ({ ImportModal: () => null }));
vi.mock('./multisig/backup/airgap-qr-import-modal', () => ({ AirgapQrImportModal: () => null }));
vi.mock('./multisig/backup/export-helpers', () => ({ exportSingleBackup: vi.fn() }));
const proposePayment = vi.fn();
vi.mock('../../people/use-frost-room', () => ({
  proposePayment: (...a: unknown[]) => proposePayment(...a),
  declinePayment: vi.fn(),
  sealPayment: vi.fn(),
}));

const { FrostApprove } = await import('./frost-approve');
const { SettingsMultisigBackup } = await import('./settings/settings-multisig-backup');
const { ProposeSheet } = await import('./inbox/payments');
const { usePasswordGate } = await import('../../hooks/password-gate');

const settle = () => act(() => new Promise(r => setTimeout(r, 120)));
const button = (name: string) =>
  [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === name);
const asked = () => document.querySelector('input[placeholder=password]') !== null;

describe('a zigner is selected, and a share is opened', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    getMultisigSecrets.mockClear();
    proposePayment.mockClear();
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
  });
  const render = (el: React.ReactElement, at = '/') =>
    act(() => root.render(createElement(MemoryRouter, { initialEntries: [at] }, el)));

  it('frost approve asks for the password before the share is read', async () => {
    render(createElement(FrostApprove), '/?action=frost-sign&requestId=r&sighashHex=00');
    await settle();
    act(() => button('approve')!.click());
    await settle();
    expect(asked()).toBe(true);
    expect(getMultisigSecrets).not.toHaveBeenCalled();
  });

  it('propose and seal asks for the password before anything is built', async () => {
    const Sheet = () => {
      const { requestAuth, PasswordModal } = usePasswordGate();
      return createElement(
        'div',
        null,
        createElement(ProposeSheet, {
          open: true,
          onClose: vi.fn(),
          room: {} as never,
          seat: seat as never,
          to: 'u1someone',
          requestAuth,
        }),
        PasswordModal,
      );
    };
    render(createElement(Sheet));
    await settle();
    const amount = document.querySelector<HTMLInputElement>('input[aria-label=amount]')!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      set.call(amount, '0.1');
      amount.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => button('propose and seal')!.click());
    await settle();
    expect(asked()).toBe(true);
    expect(proposePayment).not.toHaveBeenCalled();
  });

  it('a multisig backup export asks for the password', async () => {
    render(createElement(SettingsMultisigBackup));
    await settle();
    act(() => button('export')!.click());
    await settle();
    expect(asked()).toBe(true);
  });
});
