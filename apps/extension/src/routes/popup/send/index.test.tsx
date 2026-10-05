import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// the zcash form is replaced: only the network it is handed matters here
const zcashProps = vi.fn();
vi.mock('./zcash-send', () => ({
  ZcashSend: (p: { mainnet: boolean }) => {
    zcashProps(p);
    return null;
  },
}));
vi.mock('./cosmos-send', () => ({ CosmosSend: () => null }));
vi.mock('./penumbra-send', () => ({ PenumbraSend: () => null }));
vi.mock('./ibc-send', () => ({ PenumbraIbcSend: () => null }));
vi.mock('../../../transparent/penumbra-routes', () => ({
  offeredChains: () => [],
  usePenumbraRoutes: () => ({}),
}));
vi.mock('../../../hooks/transparent-holdings', () => ({ useTransparentHoldings: () => ({}) }));

const state = {
  wallets: { zcashWallets: [{ id: 'w', mainnet: false, address: 'utest1x' }], activeZcashIndex: 0 },
  keyRing: { activeNetwork: 'zcash' },
  pockets: { book: {} },
};
vi.mock('../../../state', () => ({
  useStore: (selector: (s: typeof state) => unknown) => selector(state),
}));
vi.mock('../../../state/keyring', () => ({ selectActiveNetwork: () => 'zcash' }));
vi.mock('../../../state/pockets', () => ({ activeAccountIndex: () => 0 }));

const { SendPage } = await import('./index');

describe('SendPage', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("hands the zcash form the active wallet's network, not mainnet always", () => {
    act(() =>
      root.render(
        <MemoryRouter initialEntries={['/send']}>
          <SendPage />
        </MemoryRouter>,
      ),
    );
    expect(zcashProps).toHaveBeenCalled();
    expect(zcashProps.mock.lastCall?.[0].mainnet).toBe(false);
    state.wallets.zcashWallets[0]!.mainnet = true;
    act(() =>
      root.render(
        <MemoryRouter initialEntries={['/send']}>
          <SendPage />
        </MemoryRouter>,
      ),
    );
    expect(zcashProps.mock.lastCall?.[0].mainnet).toBe(true);
  });
});
