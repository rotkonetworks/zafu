// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const optIn = vi.fn<(d: string) => Promise<boolean>>();
vi.mock('../net/egress-opt-in', () => ({ requestEgressOptIn: (d: string) => optIn(d) }));

import { useGasSponsor, type GasState } from './sponsor';

const USDC_INJ = 'erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a';
// one usdc.inj, no inj: the address the sponsor exists for
const NEEDS_SPONSOR = [{ denom: USDC_INJ, amount: 1_000_000n }];

const run = async (balances: { denom: string; amount: bigint }[]) => {
  let state: GasState | undefined;
  const Probe = () => {
    state = useGasSponsor('injective', 'ibc', balances);
    return null;
  };
  const el = document.createElement('div');
  const root = createRoot(el);
  const client = new QueryClient();
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  await act(() => new Promise(r => setTimeout(r, 30)));
  root.unmount();
  return state!;
};

afterEach(() => {
  optIn.mockReset();
  vi.unstubAllGlobals();
});

describe('the injective gas sponsor', () => {
  it('asks for the sponsor before contacting it, then pays the fee', async () => {
    optIn.mockResolvedValue(true);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ granter: 'inj1granter' })));
    vi.stubGlobal('fetch', fetchMock);
    const s = await run(NEEDS_SPONSOR);
    expect(optIn).toHaveBeenCalledWith('sponsor');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(s.sponsored).toBe(true);
  });

  it('contacts nothing when the person says not now', async () => {
    optIn.mockResolvedValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const s = await run(NEEDS_SPONSOR);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.sponsored).toBe(false);
  });

  it('neither asks nor contacts when the address can pay its own fee', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const s = await run([...NEEDS_SPONSOR, { denom: 'inj', amount: 10n ** 18n }]);
    expect(optIn).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.gasOk).toBe(true);
  });
});
