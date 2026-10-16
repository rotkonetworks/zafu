// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const optIns: Record<string, string> = {};
const setOptIn = vi.fn(async () => undefined);
vi.mock('../../../net/ledger', () => ({
  readNetEgress: async () => ({ destinations: {}, optIns }),
  setDestinationOptIn: (...a: unknown[]) => setOptIn(...(a as [])),
}));
vi.mock('../../../net/egress-opt-in', () => ({
  readEgressInputs: async () => ({ enabledNetworks: ['penumbra'], netEgress: { optIns } }),
}));
vi.stubGlobal('chrome', {
  storage: { onChanged: { addListener: () => undefined, removeListener: () => undefined } },
});

import { NymRouteLine } from './nym-rows';

const show = async () => {
  const el = document.createElement('div');
  const root = createRoot(el);
  await act(async () => root.render(<NymRouteLine group='penumbra' slower='about 10 s more' />));
  await act(() => new Promise(r => setTimeout(r, 10)));
  return { el, root };
};

afterEach(() => {
  setOptIn.mockClear();
  for (const k of Object.keys(optIns)) {
    delete optIns[k];
  }
});

describe('the nym line where a send waits on it', () => {
  it('says a penumbra send goes over nym by default, and goes direct in one tap', async () => {
    const { el, root } = await show();
    expect(el.textContent).toContain('over nym · about 10 s more');
    await act(async () => el.querySelector('button')!.click());
    expect(setOptIn).toHaveBeenCalledWith('nym:penumbra', 'blocked');
    root.unmount();
  });

  it('once direct, says what the node sees and offers nym back', async () => {
    optIns['nym:penumbra'] = 'blocked';
    const { el, root } = await show();
    expect(el.textContent).toContain('direct · the node sees your ip with the send');
    await act(async () => el.querySelector('button')!.click());
    // back to the default, which is nym
    expect(setOptIn).toHaveBeenCalledWith('nym:penumbra', undefined);
    root.unmount();
  });

  it('says nothing while nym is off altogether', async () => {
    optIns.nym = 'blocked';
    const { el, root } = await show();
    expect(el.textContent).toBe('');
    root.unmount();
  });
});
