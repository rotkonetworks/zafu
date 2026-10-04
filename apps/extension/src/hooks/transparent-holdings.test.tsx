import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// every chain a flow turned on; a tap on one must ask only that one
const ON = ['injective', 'noble', 'osmosis'];
const state = {
  keyRing: {
    selectedKeyInfo: { id: 'vault-1', type: 'mnemonic' },
    enabledNetworks: ['penumbra', ...ON],
    getMnemonic: () => Promise.resolve('test phrase'),
  },
};
vi.mock('../state', () => ({ useStore: (pick: (s: unknown) => unknown) => pick(state) }));
vi.mock('../state/keyring', () => ({
  selectEffectiveKeyInfo: (s: typeof state) => s.keyRing.selectedKeyInfo,
  selectEnabledNetworks: (s: typeof state) => s.keyRing.enabledNetworks,
  keyRingSelector: (s: typeof state) => s.keyRing,
}));

// the nodes a check asks, by chain: the requests a tap makes
const asked = vi.hoisted(() => [] as string[]);
vi.mock('../transparent/chain-check', () => ({
  readCheck: () => Promise.resolve(null),
  runCheck: (_key: string, chainId: string) => {
    asked.push(chainId);
    return Promise.resolve({ at: 1, funded: [], missed: 0 });
  },
}));

import { useTransparentHoldings } from './transparent-holdings';

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  asked.length = 0;
});

const mount = () => {
  const hook: { current?: ReturnType<typeof useTransparentHoldings> } = {};
  const Probe = () => {
    hook.current = useTransparentHoldings();
    return null;
  };
  root = createRoot(document.createElement('div'));
  act(() =>
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        <Probe />
      </QueryClientProvider>,
    ),
  );
  return hook;
};

describe('transparent holdings', () => {
  it('asks nothing until a tap', async () => {
    const hook = mount();
    await act(() => Promise.resolve());
    expect([...hook.current!.chains].sort()).toEqual([...ON].sort());
    expect(asked).toEqual([]);
  });

  it("one tap asks that chain's nodes, and no other chain's", async () => {
    const hook = mount();
    await act(async () => {
      hook.current!.check('noble');
      await Promise.resolve();
    });
    expect(asked).toEqual(['noble']);
    await act(async () => {
      hook.current!.check('injective');
      await Promise.resolve();
    });
    expect(asked).toEqual(['noble', 'injective']);
    expect(hook.current!.statusOf('osmosis').status).toBe('unchecked');
  });
});
