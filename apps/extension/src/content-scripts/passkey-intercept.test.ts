/**
 * The MAIN-world passkey intercept has no chrome.runtime - that is the whole
 * reason it speaks to the ISOLATED bridge over window.postMessage. These tests
 * pin the wire contract: requests leave over postMessage with no chrome call,
 * the request never carries an `origin` field (the worker derives it from the
 * browser-attested sender), and the bridge's response is mapped back to a
 * PublicKeyCredential. A decline falls back to the platform authenticator.
 */
import { describe, it, expect, beforeAll, beforeEach, vi, type Mock } from 'vitest';

const platformCreate = vi.fn(async () => ({ id: 'platform-create' }) as unknown as Credential);
const platformGet = vi.fn(async () => ({ id: 'platform-get' }) as unknown as Credential);

let postSpy: Mock;

beforeAll(async () => {
  // jsdom has neither a secure-context flag, PublicKeyCredential, nor a
  // CredentialsContainer; the intercept no-ops without them, so stub all three
  // before the module runs its top-level wrap.
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  (window as unknown as { PublicKeyCredential: unknown }).PublicKeyCredential = class {};
  Object.defineProperty(navigator, 'credentials', {
    value: { create: platformCreate, get: platformGet },
    configurable: true,
  });
  await import('./passkey-intercept');
});

beforeEach(() => {
  platformCreate.mockClear();
  platformGet.mockClear();
  postSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});

/** the request the intercept posted to the bridge */
const lastRequest = (): {
  channel: string;
  direction: string;
  id: string;
  kind: string;
  payload: Record<string, unknown>;
} => postSpy.mock.calls.at(-1)![0] as never;

/** impersonate the ISOLATED bridge answering over window.postMessage */
const bridgeResponds = (request: { id: string }, result: unknown): void => {
  const ev = new MessageEvent('message', {
    data: { channel: 'zafu-passkey', direction: 'response', id: request.id, result },
  });
  Object.defineProperty(ev, 'source', { value: window });
  window.dispatchEvent(ev);
};

describe('passkey intercept → bridge relay', () => {
  it('sends create over postMessage (no chrome) and maps the response', async () => {
    // the MAIN world is a plain https page: nothing in the intercept may reach
    // for chrome.runtime (that call is what used to throw and drop every
    // request), so the relay must be the only channel used.
    const sendMessage = vi.spyOn(chrome.runtime, 'sendMessage');

    const promise = navigator.credentials.create({
      publicKey: {
        rp: { id: 'passkey.example', name: 'Passkey' },
        challenge: Uint8Array.from([1, 2]),
        user: { id: Uint8Array.from([3]), name: 'a@b.example', displayName: 'A' },
      },
    } as CredentialCreationOptions);

    const req = lastRequest();
    expect(req.channel).toBe('zafu-passkey');
    expect(req.direction).toBe('request');
    expect(req.kind).toBe('create');
    expect(req.payload).toEqual({
      rpId: 'passkey.example',
      rpName: 'Passkey',
      challenge: '0102',
      userName: 'a@b.example',
      userDisplayName: 'A',
      userId: '03',
      prfRequested: false,
    });
    // never sent: the worker takes the origin from the sender, not the caller
    expect(req.payload).not.toHaveProperty('origin');
    expect(platformCreate).not.toHaveBeenCalled();

    bridgeResponds(req, {
      success: true,
      credentialId: 'abcd',
      authenticatorData: '0102',
      publicKey: '04aa',
      prfEnabled: true,
    });

    const cred = (await promise) as unknown as PublicKeyCredential;
    expect(cred.id).toBe('q80'); // base64url of 0xab 0xcd
    expect(cred.type).toBe('public-key');
    expect(
      Array.from(
        new Uint8Array((cred.response as AuthenticatorAttestationResponse).getPublicKey()!),
      ),
    ).toEqual([0x04, 0xaa]);
    expect(cred.getClientExtensionResults()).toEqual({ prf: { enabled: true } });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('falls back to the platform authenticator when the wallet declines', async () => {
    const options = {
      publicKey: {
        rp: { id: 'passkey.example' },
        challenge: Uint8Array.from([1, 2]),
        user: { id: Uint8Array.from([3]), name: 'a@b.example' },
      },
    } as CredentialCreationOptions;

    const promise = navigator.credentials.create(options);
    bridgeResponds(lastRequest(), { success: false, error: 'denied' });

    await expect(promise).resolves.toEqual({ id: 'platform-create' });
    expect(platformCreate).toHaveBeenCalledWith(options);
  });

  it('relays get with clientDataHash + prf salts and maps the signature back', async () => {
    const promise = navigator.credentials.get({
      publicKey: {
        rpId: 'passkey.example',
        challenge: Uint8Array.from([5, 6]),
        allowCredentials: [{ id: Uint8Array.from([0xab]), type: 'public-key' }],
        extensions: { prf: { eval: { first: Uint8Array.from([9]) } } },
      },
    } as CredentialRequestOptions);

    await vi.waitFor(() => expect(postSpy).toHaveBeenCalled()); // the clientDataJSON hash precedes the post
    const req = lastRequest();
    expect(req.kind).toBe('get');
    expect(req.payload).toMatchObject({
      rpId: 'passkey.example',
      prfSalts: { first: '09' },
      allowCredentials: [{ id: 'ab', type: 'public-key' }],
    });
    // clientDataHash is the SHA-256 of the clientDataJSON the worker signs
    expect(req.payload['clientDataHash']).toMatch(/^[0-9a-f]{64}$/);

    bridgeResponds(req, {
      success: true,
      credentialId: 'abcd',
      authenticatorData: '0102',
      signature: '0a0b',
      prfResults: { first: 'ff' },
    });

    const cred = (await promise) as unknown as PublicKeyCredential;
    const res = cred.response as AuthenticatorAssertionResponse;
    expect(Array.from(new Uint8Array(res.signature))).toEqual([0x0a, 0x0b]);
    expect(cred.getClientExtensionResults()).toEqual({
      prf: { results: { first: Uint8Array.from([0xff]).buffer } },
    });
  });

  it('sends excludeCredentials, and a passkey the site already holds is InvalidStateError', async () => {
    const promise = navigator.credentials.create({
      publicKey: {
        rp: { id: 'passkey.example' },
        challenge: Uint8Array.from([1, 2]),
        user: { id: Uint8Array.from([3]), name: 'a@b.example' },
        excludeCredentials: [{ id: Uint8Array.from([0x03, 0x01]), type: 'public-key' }],
      },
    } as CredentialCreationOptions);
    const req = lastRequest();
    expect(req.payload['excludeCredentials']).toEqual([{ id: '0301', type: 'public-key' }]);
    bridgeResponds(req, { success: false, code: 'exists' });

    await expect(promise).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(platformCreate).not.toHaveBeenCalled();
  });

  it('hands the site the account (userHandle) the wallet recovered', async () => {
    const promise = navigator.credentials.get({
      publicKey: { rpId: 'passkey.example', challenge: Uint8Array.from([5, 6]) },
    } as CredentialRequestOptions);
    await vi.waitFor(() => expect(postSpy).toHaveBeenCalled());
    bridgeResponds(lastRequest(), {
      success: true,
      credentialId: '0301',
      authenticatorData: '01',
      signature: '02',
      userHandle: 'a1a1',
    });
    const res = ((await promise) as unknown as PublicKeyCredential)
      .response as AuthenticatorAssertionResponse;
    expect(Array.from(new Uint8Array(res.userHandle!))).toEqual([0xa1, 0xa1]);
  });

  it('leaves autofill (conditional) sign-in to the browser: nobody clicked', async () => {
    const options = {
      mediation: 'conditional',
      publicKey: { rpId: 'passkey.example', challenge: Uint8Array.from([5, 6]) },
    } as CredentialRequestOptions;
    await expect(navigator.credentials.get(options)).resolves.toEqual({ id: 'platform-get' });
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('ignores a response addressed to another request id', async () => {
    const promise = navigator.credentials.create({
      publicKey: {
        rp: { id: 'passkey.example' },
        challenge: Uint8Array.from([1, 2]),
        user: { id: Uint8Array.from([3]), name: 'a@b.example' },
      },
    } as CredentialCreationOptions);

    bridgeResponds({ id: 'someone-else' }, { success: true, credentialId: 'abcd' });
    bridgeResponds(lastRequest(), { success: false });

    await expect(promise).resolves.toEqual({ id: 'platform-create' });
  });

  it('surfaces a wallet failure after approval instead of rerouting to the platform', async () => {
    // the user already answered the consent screen; the browser's own
    // authenticator prompt cannot satisfy a credential that lives in zafu, so
    // falling back here is what made the wallet read as "stopped working".
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const promise = navigator.credentials.create({
      publicKey: {
        rp: { id: 'passkey.example' },
        challenge: Uint8Array.from([1, 2]),
        user: { id: Uint8Array.from([3]), name: 'a@b.example' },
      },
    } as CredentialCreationOptions);
    bridgeResponds(lastRequest(), { success: false, error: 'keyring locked', code: 'failed' });

    await expect(promise).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(platformCreate).not.toHaveBeenCalled();
  });

  it('surfaces a signing failure instead of rerouting to the platform', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const promise = navigator.credentials.get({
      publicKey: { rpId: 'passkey.example', challenge: Uint8Array.from([5, 6]) },
    } as CredentialRequestOptions);

    await vi.waitFor(() => expect(postSpy).toHaveBeenCalled());
    bridgeResponds(lastRequest(), { success: false, error: 'keyring locked', code: 'failed' });

    await expect(promise).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(platformGet).not.toHaveBeenCalled();
  });
});
