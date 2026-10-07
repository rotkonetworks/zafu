import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Lets react-dom's act() run outside a test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// discovery is plain storage the service worker reads; the rows only need that
let stored: unknown;
const set = vi.fn(async (_key: string, value: unknown) => {
  stored = value;
});
vi.mock('@repo/storage-chrome/local', () => ({
  localExtStorage: {
    get: async () => stored,
    set: (key: string, value: unknown) => set(key, value),
  },
}));

let state: unknown;
vi.mock('../../../state', () => ({
  useStore: (select: (s: unknown) => unknown) => select(state),
}));
vi.mock('../../../state/keyring', () => ({
  selectEnabledNetworks: (s: { keyRing: { enabledNetworks: string[] } }) =>
    s.keyRing.enabledNetworks,
}));
vi.mock('../../../services/zcashme/config', () => ({
  useZcashMeMode: () => 'off',
  ZCASHME_MODE_LABEL: { off: 'off' },
}));
vi.mock('../../../utils/navigate', () => ({ usePopupNav: () => () => undefined }));
vi.mock('./settings-screen', () => ({
  SettingsScreen: ({ children }: { children: unknown }) => children,
  Section: ({ children }: { children: unknown }) => children,
}));

import { DEFAULT_CONTACT_DISCOVERY_RELAY } from '../../../config/contact-discovery-relay';
import { DEFAULT_PRIVACY_SETTINGS } from '../../../state/privacy';
import { ContactDiscoveryRow, SettingsPeople } from './settings-people';
import { DiscoveryRelayRow } from './relay-rows';

/** Set a controlled input the way a user's keystroke does. */
const type = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const input = (label: string) =>
  document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;

/** the "discovery relay" value row: its "?" makes it a div[role=button] */
const openRelaySheet = (): void => {
  const hit = [...document.querySelectorAll('button, [role="button"]')].find(b =>
    [...b.querySelectorAll('span')][0]?.textContent?.startsWith('discovery relay'),
  );
  if (!hit) throw new Error('no "discovery relay" row');
  (hit as HTMLElement).click();
};

const toggle = () => document.querySelector('button[role="switch"]') as HTMLButtonElement;

let root: Root;
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

const render = async (el: Parameters<typeof root.render>[0]) => {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(el));
  await flush();
};

beforeEach(() => {
  set.mockClear();
  state = {
    privacy: { settings: DEFAULT_PRIVACY_SETTINGS, setSetting: vi.fn() },
    keyRing: { enabledNetworks: ['zcash'] },
  };
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
});

describe('contact discovery and its relay', () => {
  const both = createElement(
    Fragment,
    null,
    createElement(ContactDiscoveryRow),
    createElement(DiscoveryRelayRow),
  );

  it('turning on never pins the default relay as a choice', async () => {
    stored = { enabled: false, relayEndpoint: '', relayToken: '' };
    await render(both);
    act(() => toggle().click());
    await flush();
    expect(set).toHaveBeenCalledWith('zidDiscovery', {
      enabled: true,
      relayEndpoint: '',
      relayToken: '',
    });
  });

  it('keeps a relay and token the user typed, trimmed', async () => {
    stored = { enabled: false, relayEndpoint: '', relayToken: '' };
    await render(both);
    act(() => openRelaySheet());
    await flush();
    expect(input('relay').value).toBe(DEFAULT_CONTACT_DISCOVERY_RELAY);
    act(() => {
      type(input('relay'), '  https://mine.example  ');
      type(input('token'), ' token-1 ');
    });
    await act(async () => {
      input('relay').form!.requestSubmit();
    });
    await flush();
    expect(set).toHaveBeenLastCalledWith('zidDiscovery', {
      enabled: false,
      relayEndpoint: 'https://mine.example',
      relayToken: 'token-1',
    });
  });

  it('turning discovery off leaves a custom relay in place', async () => {
    stored = { enabled: true, relayEndpoint: 'https://mine.example', relayToken: 'token-1' };
    await render(both);
    act(() => toggle().click());
    await flush();
    expect(set).toHaveBeenCalledWith('zidDiscovery', {
      enabled: false,
      relayEndpoint: 'https://mine.example',
      relayToken: 'token-1',
    });
  });
});

describe('the people screen', () => {
  it('shows discovery while zid is on, and zcash.me while zcash is on', async () => {
    stored = undefined;
    await render(createElement(SettingsPeople));
    const text = document.body.textContent ?? '';
    expect(text).toContain('contact discovery');
    expect(text).toContain('zcash.me names');
  });

  it('hides discovery with zid off, and zcash.me with zcash off', async () => {
    state = {
      privacy: {
        settings: { ...DEFAULT_PRIVACY_SETTINGS, enableIdentity: false },
        setSetting: vi.fn(),
      },
      keyRing: { enabledNetworks: ['penumbra'] },
    };
    await render(createElement(SettingsPeople));
    const text = document.body.textContent ?? '';
    expect(text).toContain('zid identity');
    expect(text).not.toContain('contact discovery');
    expect(text).not.toContain('zcash.me');
  });
});
