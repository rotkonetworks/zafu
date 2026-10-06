import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let key: unknown;
vi.mock('../state', () => ({
  useStore: (selector: (s: unknown) => unknown) => selector({}),
}));
vi.mock('../state/keyring', () => ({ selectEffectiveKeyInfo: () => key }));
vi.mock('../state/password', () => ({ passwordSelector: () => ({ isPassword: vi.fn() }) }));

const { usePasswordGate } = await import('./password-gate');

describe('usePasswordGate', () => {
  let host: HTMLDivElement;
  let root: Root;
  let gate: ReturnType<typeof usePasswordGate>;
  const Probe = () => {
    gate = usePasswordGate();
    return gate.PasswordModal;
  };
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  // the device's own review and qr are the confirmation: no dialog before them
  it('lets a zigner through without a dialog', async () => {
    key = { type: 'zigner-zafu', insensitive: {} };
    act(() => root.render(createElement(Probe)));
    await expect(gate.requestAuth()).resolves.toBe(true);
    expect(document.querySelector('[role=dialog]')).toBeNull();
  });

  it('asks a phrase wallet for its password', async () => {
    key = { type: 'mnemonic', insensitive: {} };
    act(() => root.render(createElement(Probe)));
    let settled = false;
    act(() => void gate.requestAuth().then(() => (settled = true)));
    await act(() => new Promise(r => setTimeout(r, 60)));
    expect(document.querySelector('input[placeholder=password]')).not.toBeNull();
    expect(settled).toBe(false);
  });
});
