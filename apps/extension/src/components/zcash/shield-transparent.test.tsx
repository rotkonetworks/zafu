/**
 * The shield sheet, mounted, with the worker answering: once a shield goes out
 * the figures are read again (home counts it as arriving at once), and the
 * sheet keeps saying what it moved and for what fee, though the live figures
 * behind it have gone to zero.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const t = vi.hoisted(() => ({
  last: {} as { at: number; height: number; zat: bigint; funded: number; utxos?: unknown[] },
  shielded: vi.fn(),
}));
vi.mock('../../hooks/zcash-transparent-balance', () => ({
  useTransparentBalance: () => ({
    last: t.last,
    checking: false,
    failed: false,
    check: vi.fn(),
    shielded: t.shielded,
  }),
}));
vi.mock('../../hooks/password-gate', () => ({
  usePasswordGate: () => ({ requestAuth: () => Promise.resolve(true), PasswordModal: null }),
}));
vi.mock('../../state/keyring', async orig => ({
  ...(await orig<object>()),
  selectEffectiveKeyInfo: () => ({ id: 'w1', type: 'mnemonic', insensitive: {} }),
  keyRingSelector: () => ({ getVaultUnlock: () => Promise.resolve({}) }),
}));
vi.mock('../../state/pockets', async orig => ({
  ...(await orig<object>()),
  activeZcashStoreId: () => 'w1',
  activeAccountIndex: () => 0,
  activePockets: () => [],
}));
vi.mock('../../state/keyring/network-worker', async orig => ({
  ...(await orig<object>()),
  shieldInWorker: () =>
    Promise.resolve({
      txid: 'ab'.repeat(32),
      shieldedZat: '485000',
      feeZat: '15000',
      utxoCount: 1,
    }),
}));

import { ShieldTransparent } from './shield-transparent';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = '';
});

const coin = { address: 't1a', valueZat: 500_000n };

describe('the shield sheet', () => {
  it('reads the figures again as the shield goes out, and keeps what it moved and its fee', async () => {
    t.last = { at: 1, height: 1, zat: 500_000n, funded: 1, utxos: [coin] };
    const client = new QueryClient();
    const reread = vi.spyOn(client, 'invalidateQueries');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const sheet = (zat: bigint) => (
      <QueryClientProvider client={client}>
        <ShieldTransparent
          transparentZat={zat}
          utxoLoading={false}
          hasMnemonic
          tAddresses={['t1a']}
          funded={zat > 0n ? 1 : 0}
          isMainnet
          zidecarUrl='https://example.invalid'
        />
      </QueryClientProvider>
    );
    await act(async () => root.render(sheet(500_000n)));
    expect(host.textContent).toContain('0.00015 zec');

    const button = [...host.querySelectorAll('button')].find(b => b.textContent === 'shield')!;
    await act(async () => {
      button.click();
      await new Promise(r => setTimeout(r, 0));
    });

    expect(t.shielded).toHaveBeenCalledWith(500_000n);
    expect(reread).toHaveBeenCalledWith({ queryKey: ['zcashWorker', 'w1'] });

    // the coins leave the live figures: the sheet still says what went out
    t.last = { at: 2, height: 2, zat: 0n, funded: 0 };
    await act(async () => root.render(sheet(0n)));
    expect(host.textContent).toContain('0.005');
    expect(host.textContent).toContain('1 transparent address');
    expect(host.textContent).toContain('0.00015 zec');
    act(() => root.unmount());
  });
});
