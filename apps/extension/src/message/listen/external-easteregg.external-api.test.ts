/**
 * Tests for the external-API hardening on the multisig surface:
 *  - gh #19: same-origin approval-popup dedup (zafu_dkg_join et al.)
 *  - gh #18: zafu_delete_multisig rejects uniformly *after* the capability
 *    gate (no pre-gate label-length oracle) and uses the sanitized label.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { externalMessageListener } from './external-easteregg';
import { grantCapability, getOriginPermissions } from '@repo/storage-chrome/origin';
import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { clientDataJson } from '../../content-scripts/passkey-wire';
// Load the (mocked) state graph while the file is collected, not in a hook: the
// mock spreads the real module, and its first load under a busy full-suite run
// on CI took longer than the 10s hook timeout. Collection has no such limit.
import * as stateModule from '../../state';

/** a get as the intercept sends it: challenge aabb, client data for https://<rpId> */
const getReq = (rpId: string) => ({
  type: 'zafu_passkey_get',
  rpId,
  challenge: 'aabb',
  clientDataHash: bytesToHex(
    sha256(clientDataJson('webauthn.get', Uint8Array.from([0xaa, 0xbb]), `https://${rpId}`)),
  ),
});

// the mint/sign run in the service worker via a dynamic import of
// state/webauthn; stub it so the tests can assert mint-vs-no-mint without
// touching real seed derivation. spread the real state module and override only
// useStore so the rest of the (statically imported) graph is untouched.
const { createCredentialMock, signAssertionMock, grants } = vi.hoisted(() => ({
  grants: [] as { origin: string; rpId: string; owner: string; at: number }[],
  createCredentialMock: vi.fn(() => ({
    credentialId: Uint8Array.from([0xab, 0xcd]),
    authenticatorData: Uint8Array.from([0x01, 0x02]),
    publicKey: Uint8Array.from([0x04, 0xaa]),
  })),
  signAssertionMock: vi.fn(() => ({
    authenticatorData: Uint8Array.from([0x11]),
    signature: Uint8Array.from([0x22]),
  })),
}));
vi.mock('../../state/webauthn', () => ({
  createCredential: createCredentialMock,
  signAssertion: signAssertionMock,
  pickCredentialId: () => Uint8Array.from([0xab, 0xcd]),
}));
// the sealed grant list needs a real password key; keep it in memory here
vi.mock('../../state/passkey-grants', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readPasskeyGrants: async () => [...grants],
  recordPasskeyGrant: async (g: { origin: string; rpId: string; owner: string }) => {
    grants.unshift({ ...g, at: Date.now() });
  },
}));
vi.mock('../../state', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  const wallet = (id: string) => ({ id, type: 'mnemonic', insensitive: {} });
  const state = {
    keyRing: {
      selectedKeyInfo: wallet('key-1'),
      keyInfos: [wallet('key-1'), wallet('key-2')],
      getMnemonic: async (id: string) => (id === 'key-1' ? 'test mnemonic' : `mnemonic of ${id}`),
    },
  };
  return {
    ...actual,
    // sentinel: proves the handler's lazy `await import('../../state')` got the
    // mock and not the real store (asserted in beforeAll below). Without it a
    // lost mock only shows up as a bogus `no-wallet` far from the cause.
    __stateMock: true,
    useStore: { getState: () => state },
  };
});

const validSender = (origin: string): chrome.runtime.MessageSender => ({
  tab: { id: 1 } as chrome.tabs.Tab,
  frameId: 0,
  documentId: 'doc-1',
  documentLifecycle: 'active',
  origin,
  url: `${origin}/index.html`,
  // zafu's content scripts carry its id: passkeys arrive through the bridge
  id: chrome.runtime.id,
});

/** drives an INTERNAL popup->worker result message (must come from the extension) */
// zafu's own page: the extension id AND the extension origin (a content script
// carries the id too, so the id alone is not enough)
const internalSender = (): chrome.runtime.MessageSender =>
  ({
    id: chrome.runtime.id,
    origin: `chrome-extension://${chrome.runtime.id}`,
    url: `chrome-extension://${chrome.runtime.id}/popup.html`,
  }) as chrome.runtime.MessageSender;

/** pull the requestId the create handler embedded in the approval-popup URL */
const requestIdFromPopup = (origin: string): string => {
  const url = popupUrlFor(origin);
  if (!url) throw new Error(`no approval popup was opened for ${origin}`);
  return new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('requestId')!;
};

/** the `app` origin embedded in a popup URL */
const appParam = (url: string): string | null => {
  const q = url.indexOf('?');
  return q < 0 ? null : new URLSearchParams(url.slice(q + 1)).get('app');
};

/**
 * The approval-popup URL opened for `origin`. Scoped by origin rather than by
 * call index: a handler still in flight from a previous test opens its window
 * through the *current* `chrome.windows.create`, so `calls[0]` can belong to
 * another test when the suite runs under load.
 */
const popupUrlsFor = (origin: string): string[] =>
  createMock.mock.calls
    .map((c: unknown[]) => String((c[0] as { url?: string } | undefined)?.url ?? ''))
    .filter(u => u.includes('/passkey-approve') && appParam(u) === origin);
const popupUrlFor = (origin: string): string | undefined => popupUrlsFor(origin).at(-1);

/** wait until `origin`'s consent popup has actually opened, then hand back its URL */
const waitForPopup = async (origin: string): Promise<string> => {
  await vi.waitFor(
    () => {
      if (!popupUrlFor(origin)) throw new Error(`no approval popup was opened for ${origin}`);
    },
    { timeout: 4000, interval: 25 },
  );
  return popupUrlFor(origin)!;
};

/** wait for `origin`'s passkey screen and answer it as the person would */
const tap = async (origin: string, result: unknown) => {
  await waitForPopup(origin);
  await call(
    { type: 'zafu_passkey_result', requestId: requestIdFromPopup(origin), result },
    internalSender(),
  );
};

/** drive the listener and resolve with whatever it passes to sendResponse */
const call = (req: unknown, sender: chrome.runtime.MessageSender): Promise<any> =>
  new Promise(resolve => {
    externalMessageListener(req, sender, resolve);
  });

/** flush microtasks + the pending async handler work */
const flush = () => new Promise(r => setTimeout(r, 0));

let createMock: Mock;

beforeAll(async () => {
  // Prove dynamic importers see the mock (already loaded above, so this is a
  // cache hit). A lost mock used to surface as the handler reading the REAL
  // store (falsy selectedKeyInfo → bogus `no-wallet`) only under load.
  const mod = (await import('../../state')) as { __stateMock?: boolean };
  if (!mod.__stateMock || mod !== stateModule) {
    throw new Error('../../state mock is not in effect for dynamic imports');
  }
});

beforeEach(async () => {
  // Each test uses a unique origin, so no per-origin storage reset is needed - // and clearing would wipe the shared mock-chrome storage other test files use.
  // The capabilities these suites exercise are marked as already decided: the
  // subject here is the per-origin gate, and the one-time global opt-in
  // question (asked while a capability is `unset`) has its own suite.
  await localExtStorage.set('capabilityModes', {
    frost: 'enabled',
    passkey: 'enabled',
    connect: 'enabled',
  });
  (globalThis.chrome.runtime as unknown as { getURL: unknown }).getURL = (p: string) =>
    `chrome-extension://test/${p}`;
  createMock = vi.fn(async () => ({ id: Math.floor(Math.random() * 1e6) }));
  (globalThis.chrome as unknown as { windows: unknown }).windows = {
    create: createMock,
    onRemoved: { addListener: vi.fn() },
  };
});

describe('gh #19 - same-origin approval-popup dedup', () => {
  it('drops a second dkg_join while one popup is already open for that origin', async () => {
    const origin = 'https://dup.example';
    await grantCapability(origin, 'frost');

    // first request opens a popup and waits for its result (never responds here)
    void call({ type: 'zafu_dkg_join', roomCode: 'r1' }, validSender(origin));
    await flush();
    expect(createMock).toHaveBeenCalledTimes(1);

    // second request from the same origin, popup still open → dropped, no new window
    const second = await call({ type: 'zafu_dkg_join', roomCode: 'r2' }, validSender(origin));
    expect(second).toEqual({ error: 'denied' });
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('allows a concurrent popup for a different origin', async () => {
    const a = 'https://a.example';
    const b = 'https://b.example';
    await grantCapability(a, 'frost');
    await grantCapability(b, 'frost');

    void call({ type: 'zafu_dkg_join', roomCode: 'ra' }, validSender(a));
    await flush();
    void call({ type: 'zafu_dkg_join', roomCode: 'rb' }, validSender(b));
    await flush();

    expect(createMock).toHaveBeenCalledTimes(2);
  });
});

describe('zafu_frost_sign_disabled_unreachable - arm removed, no popup', () => {
  it('does not open a popup and responds inertly for the disabled type', async () => {
    // Even with the frost capability granted and a well-formed payload, the
    // removed arm must NOT open an approval popup. The dispatch falls through
    // to the default case, which returns a plain unknown-type error.
    const origin = 'https://frost-disabled.example';
    await grantCapability(origin, 'frost');
    const res = await call(
      {
        type: 'zafu_frost_sign_disabled_unreachable',
        roomCode: 'r1',
        sighashHex: 'a'.repeat(64),
      },
      validSender(origin),
    );
    await flush();
    expect(createMock).not.toHaveBeenCalled();
    expect(res).toEqual({ error: 'unknown message type' });
  });
});

describe('contact discovery is left to its own listeners', () => {
  it.each(['zafu_discover_contacts', 'zafu_request_contact_discovery'])(
    '%s gets no answer here, so its listener can answer',
    type => {
      const respond = vi.fn();
      const handled = externalMessageListener(
        { type, appScope: 'https://friends.example' },
        validSender('https://friends.example'),
        respond,
      );
      expect(handled).toBe(false);
      expect(respond).not.toHaveBeenCalled();
    },
  );
});

describe('gh #18 - zafu_delete_multisig uniform rejection', () => {
  it('rejects a too-short label with the uniform denied shape (granted origin)', async () => {
    const origin = 'https://del-short.example';
    await grantCapability(origin, 'frost');
    const res = await call(
      { type: 'zafu_delete_multisig', multisigLabel: 'ab' },
      validSender(origin),
    );
    expect(res).toEqual({ success: false, error: 'denied' });
  });

  it('does not leak a label-length hint to an ungranted caller (rejects after the gate)', async () => {
    // pre-fix this returned "multisigLabel must be at least 4 chars…" before
    // the capability check; now every path is the uniform gate rejection.
    const res = await call(
      { type: 'zafu_delete_multisig', multisigLabel: 'ab' },
      validSender('https://no-grant.example'),
    );
    expect(res).toEqual({ success: false, error: 'denied' });
  });

  it('rejects a valid label that matches no vault for the caller origin', async () => {
    const origin = 'https://del-nomatch.example';
    await grantCapability(origin, 'frost');
    const res = await call(
      { type: 'zafu_delete_multisig', multisigLabel: 'poker-table' },
      validSender(origin),
    );
    expect(res).toEqual({ success: false, error: 'denied' });
  });
});

describe('passkeys - one tap in zafu for every create and every sign-in', () => {
  // the mint and the signing both need the mnemonic, so every passkey request
  // waits on the shared unlock gate first; these tests run with a wallet that
  // is already unlocked (the locked cases below clear it).
  beforeEach(async () => {
    createCredentialMock.mockClear();
    signAssertionMock.mockClear();
    grants.length = 0;
    await sessionExtStorage.set('passwordKey', 'unlocked-key');
    (globalThis.chrome.windows as unknown as { getLastFocused: unknown }).getLastFocused =
      async () => ({ id: 7 });
  });

  afterEach(async () => {
    await sessionExtStorage.remove('passwordKey');
    // let any in-flight handler finish before the next test swaps chrome.windows;
    // otherwise its late popup-open lands in the *next* test's createMock.
    for (let i = 0; i < 3; i += 1) await flush();
  });

  const create = (rpId: string) => ({ type: 'zafu_passkey_create', rpId });

  it('(g) a locked wallet opens the unlock surface instead of the passkey screen', async () => {
    const origin = 'https://passkey-locked.example';
    await sessionExtStorage.remove('passwordKey');

    const res = await call(create('passkey-locked.example'), validSender(origin));

    expect(popupUrlFor(origin)).toBeUndefined();
    expect(res).toMatchObject({ success: false, code: 'cancelled' });
    expect(createCredentialMock).not.toHaveBeenCalled();
  });

  it('(h) a locked wallet refuses to sign rather than reroute the site', async () => {
    const origin = 'https://passkey-signlocked.example';
    await grantCapability(origin, 'passkey');
    await sessionExtStorage.remove('passwordKey');

    const res = await call(getReq('passkey-signlocked.example'), validSender(origin));

    expect(res).toMatchObject({ success: false, code: 'cancelled' });
    expect(signAssertionMock).not.toHaveBeenCalled();
  });

  it('(i) a mint failure after the tap is reported as failed, not as a denial', async () => {
    const origin = 'https://passkey-mintfail.example';
    createCredentialMock.mockImplementationOnce(() => {
      throw new Error('keyring locked');
    });

    const pending = call(create('passkey-mintfail.example'), validSender(origin));
    await tap(origin, { approved: true });

    expect(await pending).toMatchObject({ success: false, code: 'failed' });
  });

  it('(a) create mints nothing until the tap, and shows the site, rpId and wallet', async () => {
    const origin = 'https://passkey-a.example';

    void call(create('passkey-a.example'), validSender(origin));
    const url = await waitForPopup(origin);

    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    expect(params.get('mode')).toBe('create');
    expect(params.get('app')).toBe(origin);
    expect(params.get('rp')).toBe('passkey-a.example');
    expect(params.get('wallet')).toBe('key-1');
    expect(createCredentialMock).not.toHaveBeenCalled();
  });

  it('(b) not now answers denied and creates nothing', async () => {
    const origin = 'https://passkey-b.example';
    const pending = call(create('passkey-b.example'), validSender(origin));
    await tap(origin, { approved: false });

    expect(await pending).toEqual({ success: false, error: 'denied', code: 'denied' });
    expect(createCredentialMock).not.toHaveBeenCalled();
    expect((await getOriginPermissions(origin))?.granted ?? []).toEqual([]);
  });

  it('(b2) a tap forged by a content script answers nothing', async () => {
    const origin = 'https://passkey-b2.example';
    void call(create('passkey-b2.example'), validSender(origin));
    await waitForPopup(origin);
    // a content script in a web tab carries this extension's id
    const contentScript = { ...validSender('https://evil.example'), id: chrome.runtime.id };
    const respond = vi.fn();
    const claimed = externalMessageListener(
      {
        type: 'zafu_passkey_result',
        requestId: requestIdFromPopup(origin),
        result: { approved: true },
      },
      contentScript,
      respond,
    );
    await flush();
    expect(claimed).toBe(false);
    expect(respond).not.toHaveBeenCalled();
    expect(createCredentialMock).not.toHaveBeenCalled();
  });

  it('(c) the tap creates the credential and records which wallet made it for which rpId', async () => {
    const origin = 'https://passkey-c.example';
    const pending = call(create('passkey-c.example'), validSender(origin));
    await tap(origin, { approved: true });

    expect(await pending).toEqual({
      success: true,
      credentialId: 'abcd',
      authenticatorData: '0102',
      publicKey: '04aa',
      prfEnabled: true,
    });
    // unlocked before the request: a tap is presence, not UV
    expect(createCredentialMock).toHaveBeenCalledWith('test mnemonic', 'passkey-c.example', false);
    const perms = await getOriginPermissions(origin);
    expect(perms?.granted).toContain('passkey');
    // a passkey must not hand the site the wider connect view
    expect(perms?.granted).not.toContain('connect');
    expect(grants).toMatchObject([{ origin, rpId: 'passkey-c.example', owner: 'key-1' }]);
  });

  it('(f) a granted origin still takes a tap: nothing is signed before it', async () => {
    const origin = 'https://passkey-f.example';
    await grantCapability(origin, 'passkey');
    grants.push({ origin, rpId: 'passkey-f.example', owner: 'key-1', at: 1 });

    const pending = call(getReq('passkey-f.example'), validSender(origin));
    const url = await waitForPopup(origin);
    expect(new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('mode')).toBe('get');
    expect(signAssertionMock).not.toHaveBeenCalled();

    await tap(origin, { approved: true });
    expect(await pending).toMatchObject({ success: true, credentialId: 'abcd', signature: '22' });
    expect(signAssertionMock).toHaveBeenCalledWith(
      'test mnemonic',
      'passkey-f.example',
      hexToBytes(getReq('passkey-f.example').clientDataHash),
      undefined,
      // the wallet was already unlocked: no password, so no UV
      false,
    );
  });

  it('(f1) not now, or a closed window, signs nothing', async () => {
    const origin = 'https://passkey-f1.example';
    await grantCapability(origin, 'passkey');

    const denied = call(getReq('passkey-f1.example'), validSender(origin));
    await tap(origin, { approved: false });
    expect(await denied).toEqual({ success: false, error: 'denied', code: 'denied' });

    // the window-closed sweep hands the pending callback this shape
    const closed = call(getReq('passkey-f1.example'), validSender(origin));
    await vi.waitFor(() => expect(popupUrlsFor(origin)).toHaveLength(2));
    await tap(origin, { success: false, error: 'cancelled', cancelled: true });
    expect(await closed).toEqual({ success: false, error: 'cancelled', code: 'cancelled' });
    expect(signAssertionMock).not.toHaveBeenCalled();
  });

  it('(f6) a subdomain cannot sign for a parent rpId it never created', async () => {
    const origin = 'https://a.passkey-f6.example';
    await grantCapability(origin, 'passkey');
    grants.push({ origin, rpId: 'a.passkey-f6.example', owner: 'key-1', at: 1 });

    const res = await call(
      {
        ...getReq('passkey-f6.example'),
        clientDataHash: bytesToHex(
          sha256(clientDataJson('webauthn.get', Uint8Array.from([0xaa, 0xbb]), origin)),
        ),
      },
      validSender(origin),
    );

    expect(res).toMatchObject({ success: false });
    expect(popupUrlFor(origin)).toBeUndefined();
    expect(signAssertionMock).not.toHaveBeenCalled();
  });

  it('(f7) signs with the wallet that made the passkey, not the one selected now', async () => {
    const origin = 'https://passkey-f7.example';
    await grantCapability(origin, 'passkey');
    grants.push({ origin, rpId: 'passkey-f7.example', owner: 'key-2', at: 1 });

    const pending = call(getReq('passkey-f7.example'), validSender(origin));
    const url = await waitForPopup(origin);
    expect(new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('wallet')).toBe('key-2');
    await tap(origin, { approved: true });

    expect(await pending).toMatchObject({ success: true });
    expect(signAssertionMock).toHaveBeenCalledWith(
      'mnemonic of key-2',
      'passkey-f7.example',
      expect.anything(),
      undefined,
      false,
    );
  });

  it('(f3) a passkey made before grants were recorded (connect only) asks once, then is recorded', async () => {
    const origin = 'https://connect-only.example';
    await grantCapability(origin, 'connect');

    const pending = call(getReq('connect-only.example'), validSender(origin));
    await tap(origin, { approved: true });

    expect(await pending).toMatchObject({ success: true });
    expect((await getOriginPermissions(origin))?.granted).toContain('passkey');
    expect(grants).toMatchObject([{ origin, rpId: 'connect-only.example', owner: 'key-1' }]);
  });

  it('(f4) client data naming another origin is never signed', async () => {
    // a subdomain may claim its parent's rpId, but the client data it hands the
    // parent must still name the subdomain: here it claims the parent's origin
    const origin = 'https://sub.passkey-f4.example';
    await grantCapability(origin, 'passkey');
    const res = await call(getReq('passkey-f4.example'), validSender(origin));
    expect(res).toEqual({ success: false, error: 'client data does not match the request' });
    expect(signAssertionMock).not.toHaveBeenCalled();
  });

  it('(f5) a hash that is not of the challenge is never signed', async () => {
    const origin = 'https://passkey-f5.example';
    await grantCapability(origin, 'passkey');
    const res = await call(
      { ...getReq('passkey-f5.example'), clientDataHash: 'aa'.repeat(32) },
      validSender(origin),
    );
    expect(res).toMatchObject({ success: false });
    expect(signAssertionMock).not.toHaveBeenCalled();
  });

  it('(f2) a sign-in from an origin with neither passkey nor connect never raises a tap', async () => {
    const origin = 'https://nogrant.example';
    const res = await call(getReq('nogrant.example'), validSender(origin));

    expect(res).toEqual({ success: false, error: 'not connected' });
    expect(popupUrlFor(origin)).toBeUndefined();
    expect(signAssertionMock).not.toHaveBeenCalled();
  });

  it('the externally_connectable door, which has no click to check, gets no passkeys', async () => {
    const origin = 'https://passkey-door.example';
    await grantCapability(origin, 'passkey');
    const page = { ...validSender(origin), id: undefined };

    expect(await call(create('passkey-door.example'), page)).toMatchObject({ success: false });
    expect(await call(getReq('passkey-door.example'), page)).toMatchObject({ success: false });
    expect(popupUrlFor(origin)).toBeUndefined();
  });

  it('a second sign-in while one is waiting opens no second window', async () => {
    const origin = 'https://dedup.example';
    await grantCapability(origin, 'passkey');

    const first = call(getReq('dedup.example'), validSender(origin));
    await waitForPopup(origin);
    const second = call(getReq('dedup.example'), validSender(origin));
    expect(await second).toEqual({ success: false, error: 'cancelled', code: 'cancelled' });
    expect(popupUrlsFor(origin)).toHaveLength(1);

    await tap(origin, { approved: true });
    expect(await first).toMatchObject({ success: true });
  });
});

describe('zafu_zcash_send - top-frame gate and same-origin popup dedup', () => {
  const outputs = [{ address: 'u1test', amount: 1000 }];

  /** any approval-popup url opened for `origin`, whatever path it is under */
  const anyPopupUrlFor = (origin: string): string | undefined =>
    createMock.mock.calls
      .map((c: unknown[]) => String((c[0] as { url?: string } | undefined)?.url ?? ''))
      .find(u => appParam(u) === origin);

  it("refuses a sender that is not the tab's top frame", async () => {
    const origin = 'https://iframe.example';
    // a third-party iframe: same shape as validSender, but not frame 0 - this
    // is exactly the "wearing the host tab's identity" spoof the gate exists for
    const iframeSender: chrome.runtime.MessageSender = {
      ...validSender(origin),
      frameId: 1,
    };
    const res = await call({ type: 'zafu_zcash_send', outputs }, iframeSender);
    expect(res).toEqual({ success: false, error: 'denied', code: 'denied' });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('opens one popup for two concurrent sends from the same origin', async () => {
    const origin = 'https://send-dup.example';

    void call({ type: 'zafu_zcash_send', outputs }, validSender(origin));
    await flush();
    expect(createMock).toHaveBeenCalledTimes(1);

    const second = await call({ type: 'zafu_zcash_send', outputs }, validSender(origin));
    expect(second).toEqual({ success: false, error: 'denied' });
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('never carries the sender favicon into the approval popup url', async () => {
    const origin = 'https://no-favicon.example';
    void call(
      { type: 'zafu_zcash_send', outputs },
      {
        ...validSender(origin),
        tab: { id: 1, favIconUrl: 'https://evil.example/f.ico' } as chrome.tabs.Tab,
      },
    );
    await flush();
    const url = anyPopupUrlFor(origin);
    expect(url).toBeDefined();
    expect(url).not.toContain('favIconUrl');
    expect(url).not.toContain('evil.example');
  });
});

describe('send - own address only for a connected site', () => {
  const sendUrl = (origin: string) =>
    createMock.mock.calls
      .map((c: unknown[]) => String((c[0] as { url?: string } | undefined)?.url ?? ''))
      .filter(u => u.includes('#/send?'))
      .at(-1) ?? `no send window for ${origin}`;
  const memoOf = (url: string) => new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('memo');

  it('drops [primary] and [self] for a site the person never connected', async () => {
    const origin = 'https://send-unconnected.example';
    const res = await call(
      { type: 'send', address: 'u1x', memo: 'pay back to [primary] or [self] thanks' },
      validSender(origin),
    );
    expect(res).toEqual({ ok: true });
    expect(memoOf(sendUrl(origin))).toBe('pay back to  or  thanks');
  });

  it('keeps them for a connected site', async () => {
    const origin = 'https://send-connected.example';
    await grantCapability(origin, 'connect');
    await call({ type: 'send', address: 'u1x', memo: 'reply to [primary]' }, validSender(origin));
    expect(memoOf(sendUrl(origin))).toBe('reply to [primary]');
  });
});

describe('ping', () => {
  it('tells an unconnected site the protocol, not the release version', async () => {
    const res = await call({ type: 'ping' }, validSender('https://ping-stranger.example'));
    expect(res).toMatchObject({ zafu: true, version: '' });
    expect(typeof res.protocolVersion).toBe('number');
  });

  it('tells a connected site the release version', async () => {
    const origin = 'https://ping-friend.example';
    await grantCapability(origin, 'connect');
    const runtime = chrome.runtime as unknown as { getManifest?: () => { version: string } };
    const before = runtime.getManifest;
    runtime.getManifest = () => ({ version: '9.9.9' });
    try {
      const res = await call({ type: 'ping' }, validSender(origin));
      expect(res.version).toBe('9.9.9');
    } finally {
      runtime.getManifest = before;
    }
  });
});
