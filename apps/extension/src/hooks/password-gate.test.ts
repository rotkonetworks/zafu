import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../state', () => ({
  useStore: (selector: (s: unknown) => unknown) => selector({}),
}));
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
    act(() => root.render(createElement(Probe)));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  // a device's own review and qr are the confirmation: no dialog before them
  it('lets a pure device signature through without a dialog', async () => {
    await expect(gate.requestAuth('nothing')).resolves.toBe(true);
    expect(document.querySelector('[role=dialog]')).toBeNull();
  });

  // a caller that names nothing is treated as opening a secret
  it.each([['secret' as const], [undefined]])('asks for the password (%s)', async unseals => {
    let settled = false;
    act(() => void gate.requestAuth(unseals).then(() => (settled = true)));
    await act(() => new Promise(r => setTimeout(r, 60)));
    expect(document.querySelector('input[placeholder=password]')).not.toBeNull();
    expect(settled).toBe(false);
  });
});
