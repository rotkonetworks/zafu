/**
 * Handler contract tests for `zafu_request_contact_discovery`.
 *
 * The consent request is exercised with fake deps (no chrome, like
 * contact-discovery.test.ts): accept enables the wallet-wide setting (keeping
 * any configured relay) and resolves success, deny resolves `denied` and
 * persists nothing, an already-enabled wallet short-circuits without a popup.
 * A separate block drives the REAL deps' storage write to pin the
 * "enabled, endpoint preserved" shape the service relies on.
 */

import { describe, it, expect, vi, type Mock } from 'vitest';
import { localExtStorage } from '@repo/storage-chrome/local';
import type { ZafuRequestContactDiscoveryResponse } from '@zafu/protocol';
import { DEFAULT_CONTACT_DISCOVERY_RELAY } from '../../config/contact-discovery-relay';
import {
  contactDiscoveryRequestDeps,
  createContactDiscoveryRequestListener,
  type ConsentDecision,
  type ContactDiscoveryRequestDeps,
} from './contact-discovery-request';

const APP = 'https://poker.zk.bot';

interface TestState {
  enabled: boolean;
  relayEndpoint: string;
  relayToken: string;
}

interface TestDeps {
  deps: ContactDiscoveryRequestDeps;
  state: TestState;
  enableSpy: Mock;
}

const makeDeps = (
  overrides: Partial<ContactDiscoveryRequestDeps> = {},
  initial: Partial<TestState> = {},
): TestDeps => {
  const state: TestState = { enabled: false, relayEndpoint: '', relayToken: '', ...initial };
  const enableSpy = vi.fn(async () => {
    state.enabled = true;
    // preserve endpoint/token, like the real deps
  });
  const deps: ContactDiscoveryRequestDeps = {
    settings: async () => ({
      enabled: state.enabled,
      relayEndpoint: state.relayEndpoint.trim() || DEFAULT_CONTACT_DISCOVERY_RELAY,
    }),
    locked: async () => false,
    enable: enableSpy,
    prompt: async () => 'approved' as ConsentDecision,
    ...overrides,
  };
  return { deps, state, enableSpy };
};

const senderFor = (origin: string): chrome.runtime.MessageSender =>
  ({
    tab: { id: 1 } as chrome.tabs.Tab,
    frameId: 0,
    documentId: 'doc-1',
    documentLifecycle: 'active',
    origin,
    url: `${origin}/index.html`,
  }) as chrome.runtime.MessageSender;

const call = (
  deps: ContactDiscoveryRequestDeps,
  req: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<ZafuRequestContactDiscoveryResponse> => {
  const { promise, resolve } = Promise.withResolvers<ZafuRequestContactDiscoveryResponse>();
  createContactDiscoveryRequestListener(deps)(req, sender, resolve);
  return promise;
};

const request = { type: 'zafu_request_contact_discovery' };

describe('zafu_request_contact_discovery - consent flow', () => {
  it('an accepted request enables the feature wallet-wide and resolves success', async () => {
    // the settings already hold a custom endpoint; accepting keeps it (a request
    // must never reroute or wipe a relay the user configured) and the POPUP - not
    // the app - is told which endpoint will really be used.
    const prompt = vi.fn(async () => 'approved' as ConsentDecision);
    const { deps, state, enableSpy } = makeDeps(
      { prompt },
      { relayEndpoint: 'https://mine.example' },
    );

    const res = await call(deps, request, senderFor(APP));

    // exactly the flag - the app is told nothing about the user's relay setup
    expect(res).toEqual({ success: true, enabled: true });
    // the user consented to the endpoint that will actually be used
    expect(prompt).toHaveBeenCalledWith(APP, '', '', 'https://mine.example');
    // the setting is global (not per-origin) and the custom endpoint survives
    expect(state.enabled).toBe(true);
    expect(state.relayEndpoint).toBe('https://mine.example');
    expect(enableSpy).toHaveBeenCalledTimes(1);
  });

  it('a denied request resolves denied and persists nothing', async () => {
    const { deps, state, enableSpy } = makeDeps({ prompt: async () => 'denied' });

    const res = await call(deps, request, senderFor(APP));

    expect(res).toEqual({ success: false, error: 'denied', code: 'denied' });
    expect(state.enabled).toBe(false);
    expect(enableSpy).not.toHaveBeenCalled();
  });

  it('a cancelled popup resolves cancelled (not a denial the user never made)', async () => {
    const { deps, state } = makeDeps({ prompt: async () => 'cancelled' });

    const res = await call(deps, request, senderFor(APP));

    expect(res).toEqual({ success: false, error: 'cancelled', cancelled: true });
    expect(state.enabled).toBe(false);
  });

  it('an already-enabled wallet resolves success without prompting', async () => {
    const prompt = vi.fn(async () => 'denied' as ConsentDecision);
    const { deps } = makeDeps({ prompt }, { enabled: true, relayEndpoint: 'https://mine.example' });

    const res = await call(deps, request, senderFor(APP));

    expect(res).toEqual({ success: true, enabled: true });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('a locked wallet refuses not_available before prompting', async () => {
    const prompt = vi.fn(async () => 'approved' as ConsentDecision);
    const { deps } = makeDeps({ locked: async () => true, prompt });

    const res = await call(deps, request, senderFor(APP));

    expect(res).toEqual({ error: 'contact discovery is not available', code: 'not_available' });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('rejects a non-https / sub-frame sender', async () => {
    const { deps, enableSpy } = makeDeps();
    const res = await call(deps, request, {
      frameId: 3,
      origin: APP,
    } as chrome.runtime.MessageSender);
    expect(res).toEqual({ success: false, error: 'denied', code: 'denied' });
    expect(enableSpy).not.toHaveBeenCalled();
  });
});

describe('zafu_request_contact_discovery - real deps storage shape', () => {
  it('enable() preserves a configured endpoint/token and only flips the flag', async () => {
    // A user who set up their own relay must keep it: accepting an app's request
    // turns discovery on, it never reroutes (or wipes the token of) their relay.
    await localExtStorage.set('zidDiscovery', {
      enabled: false,
      relayEndpoint: 'https://mine.example',
      relayToken: 'tok',
    });

    await contactDiscoveryRequestDeps.enable();

    expect(await localExtStorage.get('zidDiscovery')).toEqual({
      enabled: true,
      relayEndpoint: 'https://mine.example',
      relayToken: 'tok',
    });
  });

  it('enable() on an untouched wallet leaves the endpoint blank (default relay)', async () => {
    await localExtStorage.set('zidDiscovery', {
      enabled: false,
      relayEndpoint: '',
      relayToken: '',
    });

    await contactDiscoveryRequestDeps.enable();

    expect(await localExtStorage.get('zidDiscovery')).toEqual({
      enabled: true,
      relayEndpoint: '',
      relayToken: '',
    });
  });

  it('settings() names the built-in default when the stored endpoint is blank', async () => {
    await localExtStorage.set('zidDiscovery', {
      enabled: true,
      relayEndpoint: '',
      relayToken: '',
    });

    const { relayEndpoint } = await contactDiscoveryRequestDeps.settings();

    expect(relayEndpoint).toBe(DEFAULT_CONTACT_DISCOVERY_RELAY);
  });
});
