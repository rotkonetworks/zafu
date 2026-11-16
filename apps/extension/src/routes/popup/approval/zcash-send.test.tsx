/**
 * The site's send request as the person reviews it: zafu's own fee estimate,
 * never a number the site sent, and every payment's memo.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../../state', () => ({
  useStore: (select: (s: unknown) => unknown) => select({ privacy: { settings: {} } }),
}));
vi.mock('../../../state/keyring', () => ({
  selectEffectiveKeyInfo: () => ({ id: 'k', type: 'mnemonic' }),
  selectGetVaultUnlock: () => async () => ({}),
}));
vi.mock('../../../state/wallets', () => ({ selectZcashIsMainnet: () => true }));
vi.mock('../../../state/pockets', () => ({
  activeAccountIndex: () => 0,
  activeZcashStoreId: () => 'k',
}));
vi.mock('../../../state/networks', () => ({ selectZcashEndpoint: () => 'https://zcash.test' }));
vi.mock('../../../state/keyring/network-worker', () => ({
  buildMultiSendTxInWorker: vi.fn(),
  buildSendTxInWorker: vi.fn(),
  stopBuildInWorker: vi.fn(),
}));

import { ZcashSendApproval } from './zcash-send';

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
});

const review = async (outputs: unknown[], extra: Record<string, string> = {}) => {
  const params = new URLSearchParams({
    app: 'https://poker.example',
    requestId: 'r1',
    outputsJson: JSON.stringify(outputs),
    ...extra,
  });
  const el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  await act(async () => {
    root!.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/approval/zcash-send?${params.toString()}`] },
        createElement(ZcashSendApproval),
      ),
    );
  });
  return el.textContent ?? '';
};

describe('zcash send approval', () => {
  it("shows zafu's fee, not the one the site sent", async () => {
    const text = await review([{ address: 'u1seat', amount: 100_000 }], { fee: '99000000' });
    expect(text).toContain('~0.0001 zec');
    expect(text).not.toContain('0.9900');
  });

  it('shows the memo of every payment', async () => {
    const text = await review([
      { address: 'u1rake', amount: 1000, memo: 'rake for table 7' },
      { address: 'u1escrow', amount: 5000, memo: 'escrow deposit' },
    ]);
    expect(text).toContain('rake for table 7');
    expect(text).toContain('escrow deposit');
  });
});
