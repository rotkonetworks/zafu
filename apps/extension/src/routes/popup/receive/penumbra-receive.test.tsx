/**
 * Penumbra receive across a wallet switch: while the new wallet's address
 * derives, the previous wallet's address is neither shown nor copyable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Fake {
  key: { id: string; type: string };
  wallet?: { fullViewingKey: string };
}
let state: Fake;
const listeners = new Set<() => void>();
const copies: string[] = [];
const pending = new Map<string, (a: string) => void>();
const derive = (from: string) => new Promise<string>(resolve => pending.set(from, resolve));

vi.mock('../../../state', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useStore: <T,>(sel: (s: Fake) => T) =>
      useSyncExternalStore(
        l => (listeners.add(l), () => listeners.delete(l)),
        () => sel(state),
      ),
  };
});
const keyRing = { getMnemonic: (id: string) => Promise.resolve(id) };
vi.mock('../../../state/keyring', () => ({
  selectEffectiveKeyInfo: (s: Fake) => s.key,
  selectPenumbraAccount: () => 0,
  keyRingSelector: () => keyRing,
}));
vi.mock('../../../state/wallets', () => ({
  selectPenumbraWalletOfKey: (s: Fake) => s.wallet,
  selectZcashIsMainnet: () => true,
}));
vi.mock('../../../hooks/use-address', () => ({
  derivePenumbraEphemeralFromMnemonic: (m: string) => derive(m),
  derivePenumbraEphemeralFromFvk: (fvk: string) => derive(fvk),
}));
vi.mock('../../../hooks/use-transparent-addresses', () => ({
  useTransparentAddresses: () => ({ tAddresses: [], isLoading: false }),
}));
vi.mock('@repo/ui/hooks/use-copy', () => ({
  useCopy: () => ({ copied: false, copy: (text: string) => copies.push(text) }),
}));
vi.mock('../../../components/qr-code', () => ({
  QrCode: ({ value }: { value: string }) => <div data-qr={value} />,
}));

const { PenumbraReceive } = await import('./receive-tab');

const copyButton = () =>
  [...document.querySelectorAll('button')].find(b => b.textContent === 'copy address')!;
const shown = () => document.body.textContent ?? '';
const settle = (from: string, address: string) =>
  act(async () => {
    await vi.waitFor(() => expect(pending.has(from)).toBe(true));
    pending.get(from)!(address);
    pending.delete(from);
  });
const select = (next: Fake) =>
  act(() => {
    state = next;
    listeners.forEach(l => l());
  });

describe('penumbra receive across a wallet switch', () => {
  let host: HTMLDivElement;
  let root: Root;
  const hot: Fake = { key: { id: 'hot', type: 'mnemonic' } };
  const cold: Fake = {
    key: { id: 'cold', type: 'zigner-zafu' },
    wallet: { fullViewingKey: 'coldfvk' },
  };

  beforeEach(() => {
    copies.length = 0;
    pending.clear();
    state = hot;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<PenumbraReceive />));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('never offers the hot wallet address once the cold one is selected', async () => {
    await settle('hot', 'penumbra1hot');
    expect(shown()).toContain('penumbra1hot');

    select(cold);
    expect(shown()).not.toContain('penumbra1hot');
    expect(copyButton().disabled).toBe(true);

    await settle('coldfvk', 'penumbra1cold');
    act(() => copyButton().click());
    expect(copies).toEqual(['penumbra1cold']);
  });

  it("a late derivation for the wallet left behind doesn't land", async () => {
    select(cold);
    await settle('hot', 'penumbra1hot');
    expect(shown()).not.toContain('penumbra1hot');
    expect(copyButton().disabled).toBe(true);
  });
});
