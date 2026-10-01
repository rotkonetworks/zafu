/**
 * The ask sheet end to end: a feature's `requestEgressOptIn` for an off
 * destination raises it, "allow" persists the opt-in and lets the waiting
 * request through, "not now" declines without recording a block, and an
 * already-allowed destination never raises it again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;
let nativeFetch: ReturnType<typeof vi.fn>;
const originalFetch = globalThis.fetch;

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const allowButton = (): HTMLButtonElement => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent === 'allow');
  if (!btn) {
    throw new Error('no allow button rendered - sheet is not open');
  }
  return btn as HTMLButtonElement;
};

const notNowButton = (): HTMLButtonElement => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent === 'not now');
  if (!btn) {
    throw new Error('no not-now button rendered - sheet is not open');
  }
  return btn as HTMLButtonElement;
};

const sheetOpen = (): boolean => !!document.querySelector('[role="dialog"]');

describe('the ask sheet', () => {
  let root: Root;
  let egress: typeof import('./egress');
  let optIn: typeof import('./egress-opt-in');
  let policy: typeof import('./egress-policy');
  let AskSheet: typeof import('./egress-ask-sheet').EgressAskSheet;

  beforeEach(async () => {
    vi.resetModules();
    localMock.clear();
    localMock.set('enabledNetworks', ['zcash']);

    nativeFetch = vi.fn(() => Promise.resolve(new Response('ok')));
    globalThis.fetch = nativeFetch as unknown as typeof fetch;

    egress = await import('./egress');
    optIn = await import('./egress-opt-in');
    policy = await import('./egress-policy');
    AskSheet = (await import('./egress-ask-sheet')).EgressAskSheet;

    egress.installEgress('popup', {
      load: async () =>
        policy.compileEgress(
          (await chrome.storage.local.get([...policy.EGRESS_INPUT_KEYS])) as never,
        ),
    });
    await egress.refreshEgress();

    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(AskSheet));
    });
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    globalThis.fetch = originalFetch;
  });

  it('raises the sheet for an off destination and resolves true on allow', async () => {
    const asked = optIn.requestEgressOptIn('near-swap');
    await flush();

    expect(sheetOpen()).toBe(true);
    act(() => allowButton().click());

    expect(await asked).toBe(true);
    expect(sheetOpen()).toBe(false);
  });

  it('resolves false on "not now", without recording a block', async () => {
    const asked = optIn.requestEgressOptIn('near-swap');
    await flush();

    act(() => notNowButton().click());

    expect(await asked).toBe(false);
    const view = await optIn.readEgressView();
    expect(view.find(d => d.id === 'near-swap')?.why).toBe('default-off');
  });

  it('persists the allow, so the destination is on next time without asking again', async () => {
    const first = optIn.requestEgressOptIn('near-swap');
    await flush();
    act(() => allowButton().click());
    await first;

    const view = await optIn.readEgressView();
    expect(view.find(d => d.id === 'near-swap')).toMatchObject({ on: true, why: 'you-allowed' });

    expect(await optIn.requestEgressOptIn('near-swap')).toBe(true);
    expect(sheetOpen()).toBe(false);
  });

  it('lets the feature succeed after allow, through the real fetch guard', async () => {
    await expect(fetch('https://1click.chaindefuser.com/v0/tokens')).rejects.toThrow(
      /did not contact/,
    );

    const asked = optIn.requestEgressOptIn('near-swap');
    await flush();
    act(() => allowButton().click());
    expect(await asked).toBe(true);

    await fetch('https://1click.chaindefuser.com/v0/tokens');
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });
});
