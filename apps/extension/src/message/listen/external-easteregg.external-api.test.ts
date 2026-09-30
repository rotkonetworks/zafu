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

// the mint/sign run in the service worker via a dynamic import of
// state/webauthn; stub it so the tests can assert mint-vs-no-mint without
// touching real seed derivation. spread the real state module and override only
// useStore so the rest of the (statically imported) graph is untouched.
const { createCredentialMock, signAssertionMock } = vi.hoisted(() => ({
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
  buildCredentialId: () => Uint8Array.from([0xab, 0xcd]),
}));
vi.mock('../../state', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  const state = {
    keyRing: {
      selectedKeyInfo: { id: 'key-1' },
      getMnemonic: async () => 'test mnemonic',
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
});

/** drives an INTERNAL popup->worker result message (must come from the extension) */
const internalSender = (): chrome.runtime.MessageSender =>
  ({ id: chrome.runtime.id }) as chrome.runtime.MessageSender;

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
const popupUrlFor = (origin: string): string | undefined =>
  createMock.mock.calls
    .map((c: unknown[]) => String((c[0] as { url?: string } | undefined)?.url ?? ''))
    .find(u => u.includes('/passkey-approve') && appParam(u) === origin);

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

/** drive the listener and resolve with whatever it passes to sendResponse */
const call = (req: unknown, sender: chrome.runtime.MessageSender): Promise<any> =>
  new Promise(resolve => {
    externalMessageListener(req, sender, resolve);
  });

/** flush microtasks + the pending async handler work */
const flush = () => new Promise(r => setTimeout(r, 0));

let createMock: Mock;

beforeAll(async () => {
  // Warm the mocked module and prove dynamic importers see it. A lost mock used
  // to surface as the handler reading the REAL store (falsy selectedKeyInfo →
  // bogus `no-wallet`) only when the full suite ran under load.
  const mod = (await import('../../state')) as { __stateMock?: boolean };
  if (!mod.__stateMock) throw new Error('../../state mock is not in effect for dynamic imports');
});

beforeEach(async () => {
  // Each test uses a unique origin, so no per-origin storage reset is needed —
  // and clearing would wipe the shared mock-chrome storage other test files use.
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

describe('gh #19 — same-origin approval-popup dedup', () => {
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

describe('zafu_frost_sign_disabled_unreachable — arm removed, no popup', () => {
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

describe('gh #18 — zafu_delete_multisig uniform rejection', () => {
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

describe('zafu_passkey_create — per-credential consent', () => {
  // the mint and the signing both need the mnemonic, so every passkey request
  // now waits on the shared unlock gate first; these tests run with a wallet
  // that is already unlocked (the locked cases below clear it).
  beforeEach(async () => {
    createCredentialMock.mockClear();
    signAssertionMock.mockClear();
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

  it('(g) a locked wallet opens the unlock surface instead of the consent popup', async () => {
    const origin = 'https://passkey-locked.example';
    await sessionExtStorage.remove('passwordKey');

    const res = await call(
      { type: 'zafu_passkey_create', rpId: 'passkey-locked.example' },
      validSender(origin),
    );

    // no consent screen: there is nothing to approve while the vault is sealed,
    // and approving one used to lead straight into a mint that could not run.
    expect(
      createMock.mock.calls.every((c: unknown[]) => !String(c[0]).includes('passkey-approve')),
    ).toBe(true);
    expect(res).toMatchObject({ success: false, code: 'cancelled' });
    expect(createCredentialMock).not.toHaveBeenCalled();
  });

  it('(h) a locked wallet refuses to sign rather than reroute the site', async () => {
    const origin = 'https://passkey-signlocked.example';
    await grantCapability(origin, 'passkey');
    await sessionExtStorage.remove('passwordKey');

    const res = await call(
      { type: 'zafu_passkey_get', rpId: 'passkey-signlocked.example', clientDataHash: 'aabb' },
      validSender(origin),
    );

    expect(res).toMatchObject({ success: false, code: 'cancelled' });
    expect(signAssertionMock).not.toHaveBeenCalled();
  });

  it('(i) a mint failure after approval is reported as failed, not as a denial', async () => {
    const origin = 'https://passkey-mintfail.example';
    createCredentialMock.mockImplementationOnce(() => {
      throw new Error('keyring locked');
    });

    const pending = call(
      { type: 'zafu_passkey_create', rpId: 'passkey-mintfail.example' },
      validSender(origin),
    );
    await waitForPopup(origin);
    await call(
      {
        type: 'zafu_passkey_create_result',
        requestId: requestIdFromPopup(origin),
        result: { approved: true },
      },
      internalSender(),
    );

    // `failed` is the wallet's own failure after the user said yes: the content
    // script must surface it instead of silently falling back to the platform
    // authenticator, which is what made the wallet look like it stopped working.
    expect(await pending).toMatchObject({ success: false, code: 'failed' });
  });

  it('(a) a connected origin mints nothing and opens the approval popup', async () => {
    const origin = 'https://passkey-a.example';
    await grantCapability(origin, 'connect');

    void call({ type: 'zafu_passkey_create', rpId: 'passkey-a.example' }, validSender(origin));
    const url = await waitForPopup(origin);

    // exactly one popup for this origin: a second request would have been deduped
    expect(
      createMock.mock.calls
        .map((c: unknown[]) => String((c[0] as { url?: string }).url ?? ''))
        .filter(u => appParam(u) === origin),
    ).toHaveLength(1);
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    expect(params.get('app')).toBe(origin);
    expect(params.get('requestId')).toBeTruthy();
    // no credential exists until the popup approves
    expect(createCredentialMock).not.toHaveBeenCalled();
  });

  it('(b) denial responds denied and no credential is created', async () => {
    const origin = 'https://passkey-b.example';
    await grantCapability(origin, 'connect');

    const pending = call(
      { type: 'zafu_passkey_create', rpId: 'passkey-b.example' },
      validSender(origin),
    );
    await waitForPopup(origin);
    await call(
      {
        type: 'zafu_passkey_create_result',
        requestId: requestIdFromPopup(origin),
        result: { approved: false },
      },
      internalSender(),
    );

    expect(await pending).toEqual({ success: false, error: 'denied' });
    expect(createCredentialMock).not.toHaveBeenCalled();
  });

  it('(c) approval creates the credential with the unchanged success payload', async () => {
    const origin = 'https://passkey-c.example';
    await grantCapability(origin, 'connect');

    const pending = call(
      { type: 'zafu_passkey_create', rpId: 'passkey-c.example' },
      validSender(origin),
    );
    await waitForPopup(origin);
    await call(
      {
        type: 'zafu_passkey_create_result',
        requestId: requestIdFromPopup(origin),
        result: { approved: true },
      },
      internalSender(),
    );

    expect(await pending).toEqual({
      success: true,
      credentialId: 'abcd',
      authenticatorData: '0102',
      publicKey: '04aa',
      prfEnabled: true,
    });
    expect(createCredentialMock).toHaveBeenCalledWith('test mnemonic', 'passkey-c.example');
  });

  it('(d) consent is the gate: an origin with no grant still gets the popup', async () => {
    const origin = 'https://unconn.example';

    void call({ type: 'zafu_passkey_create', rpId: 'unconn.example' }, validSender(origin));
    const url = await waitForPopup(origin);

    expect(url).toContain('/passkey-approve');
    // still no credential until the popup approves
    expect(createCredentialMock).not.toHaveBeenCalled();
  });

  it('(e) approval grants only the narrow passkey capability to the origin', async () => {
    const origin = 'https://passkey-e.example';

    const pending = call(
      { type: 'zafu_passkey_create', rpId: 'passkey-e.example' },
      validSender(origin),
    );
    await waitForPopup(origin);
    await call(
      {
        type: 'zafu_passkey_create_result',
        requestId: requestIdFromPopup(origin),
        result: { approved: true },
      },
      internalSender(),
    );

    expect(await pending).toMatchObject({ success: true });
    const perms = await getOriginPermissions(origin);
    expect(perms?.granted).toContain('passkey');
    // approving a passkey must not hand the site the wider connect view
    expect(perms?.granted).not.toContain('connect');
  });

  it('(e2) denial grants nothing', async () => {
    const origin = 'https://passkey-e2.example';

    const pending = call(
      { type: 'zafu_passkey_create', rpId: 'passkey-e2.example' },
      validSender(origin),
    );
    await waitForPopup(origin);
    await call(
      {
        type: 'zafu_passkey_create_result',
        requestId: requestIdFromPopup(origin),
        result: { approved: false },
      },
      internalSender(),
    );

    expect(await pending).toEqual({ success: false, error: 'denied' });
    expect((await getOriginPermissions(origin))?.granted ?? []).toEqual([]);
  });

  it('(f) a passkey-granted origin signs an assertion with no second popup', async () => {
    const origin = 'https://passkey-f.example';
    await grantCapability(origin, 'passkey');

    const res = await call(
      { type: 'zafu_passkey_get', rpId: 'passkey-f.example', clientDataHash: 'aabb' },
      validSender(origin),
    );

    expect(res).toMatchObject({ success: true, credentialId: 'abcd', signature: '22' });
    expect(signAssertionMock).toHaveBeenCalledWith(
      'test mnemonic',
      'passkey-f.example',
      Uint8Array.from([0xaa, 0xbb]),
      undefined,
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it('(f2) an assertion from an origin with neither passkey nor connect is refused', async () => {
    const res = await call(
      { type: 'zafu_passkey_get', rpId: 'nogrant.example', clientDataHash: 'aabb' },
      validSender('https://nogrant.example'),
    );

    expect(res).toEqual({ success: false, error: 'not connected' });
    expect(signAssertionMock).not.toHaveBeenCalled();
  });

  it('(f3) `connect` alone (no `passkey`) is refused, not accepted as a substitute', async () => {
    // regression: passkey_get used to accept a bare `connect` grant in place of
    // `passkey`, which made the passkey TTL a no-op for any connected origin.
    const origin = 'https://connect-only.example';
    await grantCapability(origin, 'connect');

    const res = await call(
      { type: 'zafu_passkey_get', rpId: 'connect-only.example', clientDataHash: 'aabb' },
      validSender(origin),
    );

    expect(res).toEqual({ success: false, error: 'not connected' });
    expect(signAssertionMock).not.toHaveBeenCalled();
  });
});

describe('zafu_passkey_get — expired grant re-asks instead of failing forever', () => {
  // signing needs the mnemonic, same as the consent-flow describe above.
  beforeEach(async () => {
    signAssertionMock.mockClear();
    await sessionExtStorage.set('passwordKey', 'unlocked-key');
  });
  afterEach(async () => {
    await sessionExtStorage.remove('passwordKey');
  });

  /** the approval-popup URL opened for `origin` via the capability-approval path
   *  (distinct from the passkey-CREATE consent screen, which uses /passkey-approve) */
  const capabilityPopupUrlFor = (origin: string): string | undefined =>
    createMock.mock.calls
      .map((c: unknown[]) => String((c[0] as { url?: string } | undefined)?.url ?? ''))
      .find(u => u.includes('/approval/capability') && appParam(u) === origin);

  const waitForCapabilityPopup = async (origin: string): Promise<string> => {
    await vi.waitFor(
      () => {
        if (!capabilityPopupUrlFor(origin)) {
          throw new Error(`no capability approval popup was opened for ${origin}`);
        }
      },
      { timeout: 4000, interval: 25 },
    );
    return capabilityPopupUrlFor(origin)!;
  };

  it('a passkey grant with no recorded expiry (pre-TTL data) re-asks, then signs on approval', async () => {
    const origin = 'https://legacy-grant.example';
    await grantCapability(origin, 'passkey');
    // simulate storage written before the expiry mechanism existed
    const perms = await getOriginPermissions(origin);
    delete perms!.expires;
    await localExtStorage.set(
      'knownSites',
      ((await localExtStorage.get('knownSites')) ?? []).map(p =>
        p.origin === origin ? perms! : p,
      ) as never,
    );

    const pending = call(
      { type: 'zafu_passkey_get', rpId: 'legacy-grant.example', clientDataHash: 'aabb' },
      validSender(origin),
    );
    await waitForCapabilityPopup(origin);
    const requestId = new URLSearchParams(
      capabilityPopupUrlFor(origin)!.slice(capabilityPopupUrlFor(origin)!.indexOf('?') + 1),
    ).get('requestId')!;
    await call(
      { type: 'zafu_capability_result', requestId, result: { approved: true } },
      internalSender(),
    );

    expect(await pending).toMatchObject({ success: true });
    expect(signAssertionMock).toHaveBeenCalled();
    // the re-approval refreshed the expiry
    expect((await getOriginPermissions(origin))?.expires?.passkey).toBeDefined();
  });

  it('a lapsed passkey grant that the user denies re-asking does not sign', async () => {
    const origin = 'https://lapsed-deny.example';
    await grantCapability(origin, 'passkey');
    const perms = await getOriginPermissions(origin);
    perms!.expires = { passkey: Date.now() - 1000 };
    await localExtStorage.set(
      'knownSites',
      ((await localExtStorage.get('knownSites')) ?? []).map(p =>
        p.origin === origin ? perms! : p,
      ) as never,
    );

    const pending = call(
      { type: 'zafu_passkey_get', rpId: 'lapsed-deny.example', clientDataHash: 'aabb' },
      validSender(origin),
    );
    await waitForCapabilityPopup(origin);
    const requestId = new URLSearchParams(
      capabilityPopupUrlFor(origin)!.slice(capabilityPopupUrlFor(origin)!.indexOf('?') + 1),
    ).get('requestId')!;
    await call(
      { type: 'zafu_capability_result', requestId, result: { approved: false } },
      internalSender(),
    );

    expect(await pending).toEqual({ success: false, error: 'denied' });
    expect(signAssertionMock).not.toHaveBeenCalled();
    expect((await getOriginPermissions(origin))?.granted ?? []).not.toContain('passkey');
  });
});
