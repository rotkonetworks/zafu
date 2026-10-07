/**
 * The swap form, mounted: its one ask on the first open covers every route,
 * and once the routes may be asked, prices follow the typed amount on their
 * own, with no button between typing and a price.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const egress = vi.hoisted(() => ({ asked: [] as unknown[] }));
vi.mock('../../../net/egress-opt-in', async orig => ({
  ...(await orig<object>()),
  readEgressView: () =>
    Promise.resolve([
      { id: 'near-swap', on: true, why: 'you-allowed' },
      { id: 'thorchain', on: true, why: 'you-allowed' },
    ]),
  requestEgressOptIn: (ids: unknown) => {
    egress.asked.push(ids);
    return Promise.resolve(true);
  },
}));
vi.mock('../../../state/swap/near', async orig => ({
  ...(await orig<object>()),
  nearPrices: () => Promise.resolve(new Map()),
}));
vi.mock('../../../state/keyring', async orig => ({
  ...(await orig<object>()),
  selectActiveNetwork: () => 'zcash',
  selectEffectiveKeyInfo: () => ({ id: 'w1', type: 'mnemonic', insensitive: {} }),
}));
vi.mock('../../../state/pockets', async orig => ({
  ...(await orig<object>()),
  activeZcashStoreId: () => 'w1',
  activeAccountIndex: () => 0,
}));
const BTC = { symbol: 'BTC', chain: 'btc', decimals: 8 };
vi.mock('../../../hooks/swap-routes', () => ({
  useSwapRoutes: () => ({ chosen: {}, choose: vi.fn() }),
  useSwapLast: () => ({
    last: { direction: 'from_zec', token: BTC },
    read: true,
    remember: vi.fn(),
  }),
}));
vi.mock('../../../hooks/use-address', () => ({
  useActiveAddress: () => ({ address: 'u1shielded' }),
}));
vi.mock('../../../hooks/use-transparent-addresses', () => ({
  useSwapTAddress: () => ({ next: { index: 3, address: 't1swap' }, claim: vi.fn() }),
}));
vi.mock('../../../hooks/use-your-addresses', () => ({
  useYourAddresses: () => ({
    yours: [{ address: 'bc1qmineaddressxxxxxxxxxxxxxxxxxxxxxxxx' }],
    remember: vi.fn(),
  }),
}));
const notes = { orchard: [], ironwood: [{ value: '37000000', spent: false }] };
vi.mock('../../../hooks/zcash-pool-balances', async orig => ({
  ...(await orig<object>()),
  usePoolNotes: () => notes,
}));
vi.mock('../../../addresses/kind', async orig => ({
  ...(await orig<object>()),
  isAddressOn: (a: string) => a.startsWith('bc1q'),
}));

import { PROVIDERS } from '../../../state/swap';
import type { Quote } from '../../../state/swap/provider';
import { SWAP_EGRESS } from '../../../state/swap/live';
import { CrosschainSwap } from './crosschain';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const quote = (amountIn: string): Quote => ({
  route: 'thor',
  amountOut: 157450n,
  amountOutText: '0.0015745',
  amountInText: amountIn,
  depositAddress: 't1vault',
  memo: '=:BTC.BTC:bc1q:1',
  recipient: 'bc1q',
  raw: undefined,
});

const wait = (ms: number) => act(() => new Promise(r => setTimeout(r, ms)));

describe('the swap form asks once and prices as you type', () => {
  it('asks every route together on open, then quotes each typed amount with no tap', async () => {
    const thor = vi
      .spyOn(PROVIDERS.thor!, 'quote')
      .mockImplementation(req => Promise.resolve(quote(req.amountIn)));
    vi.spyOn(PROVIDERS.near!, 'quote').mockRejectedValue(new Error('amount is too low'));
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    act(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter>
            <CrosschainSwap />
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    );
    await wait(1700);

    expect(egress.asked).toEqual([SWAP_EGRESS]);
    expect(SWAP_EGRESS).toEqual(expect.arrayContaining(['near-swap', 'thorchain']));
    expect(SWAP_EGRESS).not.toContain('midgard');
    expect(el.textContent).not.toContain('ask for prices');
    const opening = thor.mock.calls.length;
    expect(opening).toBeGreaterThan(0);

    const input = el.querySelector<HTMLInputElement>('input[inputmode=decimal]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(input, '0.2');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await wait(1500);

    expect(thor.mock.calls.length).toBeGreaterThan(opening);
    expect(thor.mock.lastCall?.[0]).toMatchObject({ amountIn: '0.2', dry: true });
    // nothing was tapped: no ask, no checkbox stands between typing and a price
    expect(el.querySelector('input[type=checkbox]')).toBeNull();
    // the review is a tap away, with nothing to tick first
    const review = [...el.querySelectorAll('button')].find(b => b.textContent === 'review swap');
    act(() => root.unmount());
  });
});
