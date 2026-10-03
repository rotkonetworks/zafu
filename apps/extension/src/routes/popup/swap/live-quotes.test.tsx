import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const egress = vi.hoisted(() => ({ asked: [] as string[] }));
vi.mock('../../../net/egress-opt-in', async orig => ({
  ...(await orig<object>()),
  readEgressView: () =>
    Promise.resolve([
      { id: 'near-swap', on: true, why: 'you-allowed' },
      { id: 'thorchain', on: false, why: 'default-off' },
    ]),
  requestEgressOptIn: (id: string) => {
    egress.asked.push(id);
    return Promise.resolve(false);
  },
}));
vi.mock('../../../state/keyring', async orig => ({
  ...(await orig<object>()),
  selectActiveNetwork: () => 'zcash',
  selectEffectiveKeyInfo: () => ({ id: 'w1', type: 'mnemonic', insensitive: {} }),
}));
vi.mock('../../../state/pockets', async orig => ({
  ...(await orig<object>()),
  activeZcashStoreId: () => 'w1',
}));

import { PROVIDERS } from '../../../state/swap';
import { keepSwapPreload } from '../../../state/swap/preload';
import type { Quote } from '../../../state/swap/provider';
import { HomeActions } from '../home/actions';
import { installPreload, intentHandlers } from '../preload';
import { routePreloads } from '../route-preloads';
import { PopupPath } from '../paths';
import { useSettled } from './crosschain';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mount = (node: React.ReactNode) => {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  act(() => root.render(node));
  return { el, unmount: () => act(() => root.unmount()) };
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('typing settles before anything is asked', () => {
  let set: (v: string) => void = () => undefined;
  const seen: (string | undefined)[] = [];
  const Field = () => {
    const [v, setV] = useState('0.1');
    set = setV;
    seen.push(useSettled(v, parseFloat(v) > 0));
    return null;
  };

  it('waits 400ms after the last key, keeps the last usable value meanwhile', () => {
    vi.useFakeTimers();
    const { unmount } = mount(<Field />);
    expect(seen.at(-1)).toBe('0.1');
    act(() => set('0.'));
    act(() => set('0.5'));
    act(() => vi.advanceTimersByTime(300));
    act(() => set('0.55'));
    act(() => vi.advanceTimersByTime(300));
    expect(seen.at(-1)).toBe('0.1');
    act(() => vi.advanceTimersByTime(100));
    expect(seen.at(-1)).toBe('0.55');
    // a half-typed or cleared amount never settles; the last price's amount stays
    act(() => set(''));
    act(() => vi.advanceTimersByTime(1000));
    expect(seen.at(-1)).toBe('0.55');
    unmount();
  });
});

describe('the swap button warms the price', () => {
  it('opening home asks nothing; pressing swap asks the allowed route', async () => {
    const quote = vi.spyOn(PROVIDERS.near!, 'quote').mockResolvedValue({} as Quote);
    const thor = vi.spyOn(PROVIDERS.thor!, 'quote');
    const net = vi.spyOn(globalThis, 'fetch');
    await keepSwapPreload('w1', {
      direction: 'from_zec',
      token: { symbol: 'BTC', chain: 'btc', decimals: 8 },
      amountIn: '0.12',
      zcashAddress: 'u1shielded',
      otherAddress: 'bc1qmine',
    });
    const client = new QueryClient();
    // the swap route's intent preload, fired by the layout's delegated listener
    installPreload({
      client,
      routes: [{ path: PopupPath.SWAP, handle: { preload: routePreloads.swap } }],
    });
    const { el, unmount } = mount(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <div {...intentHandlers}>
            <HomeActions />
          </div>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await act(() => new Promise(r => setTimeout(r, 50)));
    expect(quote).not.toHaveBeenCalled();
    expect(net).not.toHaveBeenCalled();

    const swap = [...el.querySelectorAll('button')].find(b => b.textContent?.trim() === 'swap')!;
    await act(async () => {
      swap.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      await new Promise(r => setTimeout(r, 50));
    });
    expect(quote).toHaveBeenCalledTimes(1);
    expect(quote.mock.lastCall?.[0]).toMatchObject({ amountIn: '0.12', dry: true });
    // a route not yet allowed is never warmed, and nothing asks for permission
    expect(thor).not.toHaveBeenCalled();
    expect(egress.asked).toEqual([]);
    unmount();
  });
});
