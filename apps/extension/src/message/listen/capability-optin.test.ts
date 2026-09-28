/**
 * The two-question consent model, exercised through the real message listener:
 *
 *   1. global — "does zafu offer this capability at all?" (`capabilityModes`,
 *      asked once, prompted with `scope=zafu`)
 *   2. per-origin — "may this site use it?" (the existing capability grant)
 *
 * What must hold: a disabled capability refuses *every* site without a prompt
 * (revocation wins over a stale per-origin grant), an undecided one asks once
 * and remembers, a cancelled prompt remembers nothing, and the FROST gate's
 * uniform rejection shape is unchanged by any of it.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { externalMessageListener } from './external-easteregg';
import { grantCapability } from '@repo/storage-chrome/origin';
import { localExtStorage } from '@repo/storage-chrome/local';

const validSender = (origin: string): chrome.runtime.MessageSender =>
  ({
    tab: { id: 1 } as chrome.tabs.Tab,
    frameId: 0,
    documentId: 'doc-1',
    documentLifecycle: 'active',
    origin,
    url: `${origin}/index.html`,
  }) as chrome.runtime.MessageSender;

const internalSender = (): chrome.runtime.MessageSender =>
  ({ id: chrome.runtime.id }) as chrome.runtime.MessageSender;

const call = (req: unknown, sender: chrome.runtime.MessageSender): Promise<any> =>
  new Promise(resolve => {
    externalMessageListener(req, sender, resolve);
  });

const flush = () => new Promise(r => setTimeout(r, 0));

/**
 * Flush until `done` holds (async handler chains resolve over several turns).
 * Bounded by wall clock rather than a fixed turn count: under a loaded
 * full-suite run the macrotask queue is shared, so 25 turns of `setTimeout 0`
 * is not a reliable bound and the assertion gave up mid-chain.
 */
const until = async (done: () => boolean, ms = 2000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await flush();
  return done();
};

/** the requestId the worker embedded in the Nth approval-popup URL */
const requestIdAt = (n: number): string => {
  const url: string = createMock.mock.calls[n]![0].url;
  return new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('requestId')!;
};

const urlAt = (n: number): string => createMock.mock.calls[n]![0].url;

const modes = () => localExtStorage.get('capabilityModes');

let createMock: Mock;

beforeEach(async () => {
  (globalThis.chrome.runtime as unknown as { getURL: unknown }).getURL = (p: string) =>
    `chrome-extension://test/${p}`;
  createMock = vi.fn(async () => ({ id: Math.floor(Math.random() * 1e6) }));
  (globalThis.chrome as unknown as { windows: unknown }).windows = {
    create: createMock,
    getLastFocused: vi.fn(async () => ({ top: 40, left: 100, width: 1200 })),
    onRemoved: { addListener: vi.fn() },
  };
  // each test uses its own capability, so a global reset is safe here (and
  // required: the mode is exactly what these tests set up).
  await localExtStorage.set('capabilityModes', {});
});

describe('global opt-in — undecided capability', () => {
  it('asks the zafu-level question once, then the per-site one', async () => {
    const origin = 'https://optin.example';
    const answer = call(
      { type: 'zafu_request_capability', capability: 'view_history' },
      validSender(origin),
    );
    await flush();

    // question 1: no site attached — the question is about zafu, not the page
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(urlAt(0)).toContain('scope=zafu');
    expect(urlAt(0)).toContain('capability=view_history');
    expect(urlAt(0)).not.toContain('app=');

    // approve it → the mode is remembered...
    await call(
      { type: 'zafu_capability_result', requestId: requestIdAt(0), result: { approved: true } },
      internalSender(),
    );
    await flush();
    expect((await modes())?.view_history).toBe('enabled');

    // ...and only then does the per-site question appear
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(urlAt(1)).toContain(`app=${encodeURIComponent(origin)}`);
    expect(urlAt(1)).not.toContain('scope=zafu');

    await call(
      { type: 'zafu_capability_result', requestId: requestIdAt(1), result: { approved: true } },
      internalSender(),
    );
    expect(await answer).toEqual({ granted: true, capability: 'view_history' });
    expect((await modes())?.view_history).toBe('enabled');
  });

  it('persists a denial as disabled and answers denied', async () => {
    const origin = 'https://optin-deny.example';
    const answer = call(
      { type: 'zafu_request_capability', capability: 'view_contacts' },
      validSender(origin),
    );
    await flush();
    await call(
      { type: 'zafu_capability_result', requestId: requestIdAt(0), result: { approved: false } },
      internalSender(),
    );

    expect(await answer).toEqual({ granted: false, denied: true, capability: 'view_contacts' });
    expect((await modes())?.view_contacts).toBe('disabled');
    // denied globally → the site question must never have been asked
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('persists nothing when the prompt is cancelled (window never opened)', async () => {
    const origin = 'https://optin-cancel.example';
    createMock = vi.fn(async () => {
      throw new Error('no window');
    });
    (globalThis.chrome as unknown as { windows: unknown }).windows = {
      create: createMock,
      onRemoved: { addListener: vi.fn() },
    };

    const answer = await call(
      { type: 'zafu_request_capability', capability: 'view_history' },
      validSender(origin),
    );

    // no decision reported and no state written: the site may retry
    expect(answer).toEqual({ granted: false, capability: 'view_history' });
    expect(await modes()).toEqual({});
  });
});

describe('global opt-in — answered capability', () => {
  it('a disabled capability refuses every site with no prompt', async () => {
    await localExtStorage.set('capabilityModes', { export_fvk: 'disabled' });

    const answer = await call(
      { type: 'zafu_request_capability', capability: 'export_fvk' },
      validSender('https://off.example'),
    );

    expect(answer).toEqual({ granted: false, denied: true, capability: 'export_fvk' });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('off beats a stale per-origin grant', async () => {
    const origin = 'https://stale-grant.example';
    await grantCapability(origin, 'view_history');
    await localExtStorage.set('capabilityModes', { view_history: 'disabled' });

    const answer = await call(
      { type: 'zafu_request_capability', capability: 'view_history' },
      validSender(origin),
    );

    expect(answer).toEqual({ granted: false, denied: true, capability: 'view_history' });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('an enabled capability with a grant answers immediately', async () => {
    const origin = 'https://already.example';
    await grantCapability(origin, 'view_contacts');
    await localExtStorage.set('capabilityModes', { view_contacts: 'enabled' });

    const answer = await call(
      { type: 'zafu_request_capability', capability: 'view_contacts' },
      validSender(origin),
    );

    expect(answer).toEqual({ granted: true, capability: 'view_contacts' });
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('global opt-in — the other gates', () => {
  it('keeps the FROST rejection uniform with the capability off', async () => {
    const origin = 'https://frost-off.example';
    await grantCapability(origin, 'frost');
    await localExtStorage.set('capabilityModes', { frost: 'disabled' });

    const answer = await call(
      { type: 'zafu_delete_multisig', multisigLabel: 'valid-label' },
      validSender(origin),
    );

    // byte-identical to a missing per-origin grant: a caller can't tell whether
    // the refusal was global or per-origin.
    expect(answer).toEqual({ success: false, error: 'denied' });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('asks the global passkey question before anything site-bound', async () => {
    const origin = 'https://passkey-optin.example';
    const answer = call(
      { type: 'zafu_passkey_create', rpId: 'passkey-optin.example' },
      validSender(origin),
    );
    await flush();

    // the first surface must be the zafu-level question, not the unlock or the
    // per-credential consent: the user is not dragged through an unlock for a
    // capability they may not want at all.
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(urlAt(0)).toContain('scope=zafu');
    expect(urlAt(0)).toContain('capability=passkey');
    expect(urlAt(0)).not.toContain('passkey-approve');

    await call(
      { type: 'zafu_capability_result', requestId: requestIdAt(0), result: { approved: true } },
      internalSender(),
    );
    await flush();
    expect((await modes())?.passkey).toBe('enabled');

    // ...and the site-bound work only starts after the global answer: the
    // unlock, not the consent screen (the mint needs the mnemonic, so the
    // consent screen must never be the first thing a locked wallet sees).
    expect(await until(() => createMock.mock.calls.length === 2)).toBe(true);
    expect(urlAt(1)).toContain('#/login');
    expect(createMock.mock.calls.every(c => !String(c[0].url).includes('passkey-approve'))).toBe(
      true,
    );
    void answer;
  });

  it('refuses a disabled passkey without an unlock or a popup', async () => {
    await localExtStorage.set('capabilityModes', { passkey: 'disabled' });

    const res = await call(
      { type: 'zafu_passkey_create', rpId: 'passkey-off.example' },
      validSender('https://passkey-off.example'),
    );

    expect(res).toEqual({ success: false, error: 'denied' });
    expect(createMock).not.toHaveBeenCalled();
  });
});
