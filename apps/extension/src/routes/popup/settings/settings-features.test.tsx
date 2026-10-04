/**
 * The Features screen is where a capability switched off from a prompt is
 * supposed to be visible and reversible, so what it renders - and what it
 * writes - is the user-facing half of the opt-in gate. Pinned here: every
 * capability gets a row, a capability nobody has answered reads `ask` (a fresh
 * install must not present as "off"), and picking a state persists it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { CAPABILITY_META, type Capability } from '@repo/storage-chrome/capabilities';

// Lets react-dom's act() run outside a test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let stored: Record<string, unknown> = {};
const setMode = vi.fn(async () => undefined);
vi.mock('../../../state/capability-modes', () => ({
  getCapabilityModes: async () => stored,
  setCapabilityMode: (cap: Capability, mode: string) => setMode(cap, mode),
}));
vi.mock('./settings-screen', () => ({
  SettingsScreen: ({ children }: { children?: unknown }) => children ?? null,
}));

import { SettingsFeatures } from './settings-features';

/** The row for one capability: the block whose state group (a radiogroup of
 * three radios) is its direct child. */
const row = (cap: Capability): HTMLElement => {
  const label = CAPABILITY_META[cap].label;
  const hit = [...document.querySelectorAll('div')].find(d => {
    const states = [...d.children].find(
      c =>
        c.getAttribute('role') === 'radiogroup' &&
        c.querySelectorAll(':scope > button').length === 3,
    );
    return !!states && (d.textContent ?? '').includes(label);
  });
  if (!hit) throw new Error(`no row for ${cap} (${label})`);
  return hit as HTMLElement;
};

/** Which of the three states is the highlighted one in that row. */
const active = (cap: Capability): string => {
  const buttons = [...row(cap).querySelectorAll('button[role="radio"]')];
  const on = buttons.find(b => b.getAttribute('aria-checked') === 'true');
  if (!on) throw new Error(`no active state in ${cap} row`);
  return (on.textContent ?? '').trim();
};

const click = (cap: Capability, label: string): void => {
  const button = [...row(cap).querySelectorAll('button')].find(b => b.textContent === label);
  if (!button) throw new Error(`no ${label} button in ${cap} row`);
  (button as HTMLButtonElement).click();
};

describe('SettingsFeatures', () => {
  let root: Root;

  const flush = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    setMode.mockClear();
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
  });

  const render = async (modes: Record<string, unknown>): Promise<void> => {
    stored = modes;
    await act(async () => {
      root.render(createElement(SettingsFeatures));
    });
    await flush();
    await flush();
  };

  it('offers a row for every capability, with the undecided state reading "ask"', async () => {
    await render({});

    for (const cap of Object.keys(CAPABILITY_META) as Capability[]) {
      // a capability nobody answered must not render as "off" - it is a question
      expect(active(cap)).toBe('ask');
    }
  });

  it('shows a revoked capability as off, so a refusal from a prompt is visible', async () => {
    await render({ frost: 'disabled', passkey: 'enabled' });

    expect(active('frost')).toBe('off');
    expect(active('passkey')).toBe('on');
    expect(active('view_history')).toBe('ask');
  });

  it('persists the state the user picks', async () => {
    await render({});

    act(() => click('export_fvk', 'off'));
    await flush();

    expect(setMode).toHaveBeenCalledWith('export_fvk', 'disabled');
    expect(active('export_fvk')).toBe('off');
  });
});
