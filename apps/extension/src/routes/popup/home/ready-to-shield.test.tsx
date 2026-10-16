// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const check = vi.fn();
const optIns: Record<string, string> = {};
const usdc = { symbol: 'USDC.inj', amount: 1_000_000n, decimals: 6 };

vi.mock('../../../hooks/transparent-holdings', () => ({
  useTransparentHoldings: () => ({
    chains: ['injective'],
    check,
    holdings: new Map([['usdc.inj', [{ chainId: 'injective', index: 0, asset: usdc }]]]),
    chainsFor: () => ['injective'],
    statusOf: () => ({ status: 'checked', at: 0 }),
  }),
}));
vi.mock('../settings/nym-rows', () => ({
  useConnections: () => ({
    inputs: { enabledNetworks: ['penumbra', 'injective'], netEgress: { optIns } },
    ledger: { destinations: {}, optIns },
  }),
}));
vi.mock('../../../state', () => ({
  useStore: (sel: (s: unknown) => unknown) =>
    sel({ privacy: { settings: { autoCheckTransparent: false }, setSetting: vi.fn() } }),
}));
vi.mock('@repo/storage-chrome/local', () => ({
  localExtStorage: { get: async () => [], set: async () => undefined },
}));
vi.mock('../../../hooks/open-link', () => ({ useOpenIntent: () => vi.fn() }));
vi.mock('../../../hooks/transparent-rpc', () => ({
  defaultRpcPool: () => [],
  getRpcPool: async () => [],
  setRpcPool: async () => undefined,
}));
vi.mock('../../../net/egress', () => ({ refreshEgress: async () => undefined }));

import { useTransparent } from './transparent-lines';

const run = async () => {
  let t: ReturnType<typeof useTransparent> | undefined;
  const Probe = () => {
    t = useTransparent();
    return null;
  };
  const root = createRoot(document.createElement('div'));
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <Probe />
      </QueryClientProvider>,
    ),
  );
  await act(() => new Promise(r => setTimeout(r, 10)));
  root.unmount();
  return t!;
};

afterEach(() => {
  check.mockClear();
  for (const k of Object.keys(optIns)) {
    delete optIns[k];
  }
});

describe('ready to shield on penumbra home', () => {
  it('checks the deposit addresses on open, with no ask, while cosmos goes over nym', async () => {
    const t = await run();
    expect(check.mock.calls.map(c => c[0])).toEqual(['injective']);
    expect(t.ready.map(r => [r.symbol, r.chain])).toEqual([['usdc.inj', 'injective']]);
  });

  it('checks nothing on its own when cosmos is set to direct: the first check asks', async () => {
    optIns['nym:cosmos'] = 'blocked';
    await run();
    expect(check).not.toHaveBeenCalled();
  });

  it('checks nothing on its own when nym is off', async () => {
    optIns.nym = 'blocked';
    await run();
    expect(check).not.toHaveBeenCalled();
  });
});
