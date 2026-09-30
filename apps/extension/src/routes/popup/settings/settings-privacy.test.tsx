import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Lets react-dom's act() run outside a test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The section only needs the storage module and the real Toggle; the rest
// of this file's imports (store, license, screen chrome) are replaced so the
// test stays about the storage the settings screen writes.
let stored: unknown;
const set = vi.fn(async (key: string, value: unknown) => {
  stored = value;
});
vi.mock('@repo/storage-chrome/local', () => ({
  localExtStorage: {
    get: async () => stored,
    set: (key: string, value: unknown) => set(key, value),
  },
}));
vi.mock('../../../state', () => ({ useStore: () => undefined }));
vi.mock('../../../state/privacy', () => ({ privacySelector: () => undefined }));
vi.mock('../../../state/keyring', () => ({ selectActiveNetwork: () => undefined }));
vi.mock('../../../state/keyring/network-types', () => ({ isIbcNetwork: () => false }));
vi.mock('../../../state/license', () => ({ isPro: () => false }));
vi.mock('./settings-screen', () => ({ SettingsScreen: () => null }));

import { DEFAULT_CONTACT_DISCOVERY_RELAY } from '../../../config/contact-discovery-relay';
import { ContactDiscoverySection } from './settings-privacy';

/** Set a controlled input the way a user's keystroke does. */
const type = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const byPlaceholder = (placeholder: string): HTMLInputElement => {
  const hit = [...document.querySelectorAll('input')].find(
    i => i.getAttribute('placeholder') === placeholder,
  );
  if (!hit) throw new Error(`no input with placeholder ${placeholder}`);
  return hit as HTMLInputElement;
};

const byText = (text: string): HTMLButtonElement => {
  const hit = [...document.querySelectorAll('button')].find(b => b.textContent === text);
  if (!hit) throw new Error(`no button labelled ${text}`);
  return hit as HTMLButtonElement;
};

describe('ContactDiscoverySection', () => {
  let root: Root;

  const flush = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    set.mockClear();
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
  });

  const render = async (zidDiscovery: unknown): Promise<void> => {
    stored = zidDiscovery;
    await act(async () => {
      root.render(createElement(ContactDiscoverySection));
    });
    await flush();
  };

  it('stores "the default relay" as blank, so a user who never chose a host is not pinned to one', async () => {
    await render({ enabled: false, relayEndpoint: '', relayToken: '' });

    // the input is pre-filled with the built-in default so opting in is one click
    expect(byPlaceholder(DEFAULT_CONTACT_DISCOVERY_RELAY).value).toBe(
      DEFAULT_CONTACT_DISCOVERY_RELAY,
    );

    act(() => byText('enable').click());
    await flush();

    // ...but that click must not write the default host down as if the user had
    // chosen it: blank keeps the wallet free to move or replace the default later.
    expect(set).toHaveBeenCalledWith('zidDiscovery', {
      enabled: true,
      relayEndpoint: '',
      relayToken: '',
    });
  });

  it('keeps a relay and token the user actually typed', async () => {
    await render({ enabled: false, relayEndpoint: '', relayToken: '' });

    act(() => {
      type(byPlaceholder(DEFAULT_CONTACT_DISCOVERY_RELAY), '  https://mine.example  ');
      type(byPlaceholder('token (only if the relay asks for one)'), ' token-1 ');
    });
    act(() => byText('enable').click());
    await flush();

    expect(set).toHaveBeenCalledWith('zidDiscovery', {
      enabled: true,
      relayEndpoint: 'https://mine.example',
      relayToken: 'token-1',
    });
  });

  it('turning discovery off leaves a custom relay in place', async () => {
    await render({ enabled: true, relayEndpoint: 'https://mine.example', relayToken: 'token-1' });

    const toggle = document.querySelector('button[role="switch"]') as HTMLButtonElement;
    act(() => toggle.click());
    await flush();

    expect(set).toHaveBeenCalledWith('zidDiscovery', {
      enabled: false,
      relayEndpoint: 'https://mine.example',
      relayToken: 'token-1',
    });
  });
});
