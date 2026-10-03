/**
 * passkey intercept - wraps navigator.credentials to offer zafu as authenticator.
 *
 * injected at document_start (before page JS can cache the original API).
 * this script runs in the MAIN world, where there is NO chrome.runtime (only
 * the page's own object, which never exposes runtime for a plain https page) -
 * reaching for it threw and every request fell straight back to the platform
 * authenticator. It therefore speaks to the ISOLATED bridge (passkey-bridge.ts)
 * over window.postMessage, exactly like injected-keplr.ts does; the bridge is
 * the only side with chrome.runtime and relays to the service worker.
 *
 * the bridge is not a trust boundary: it only carries the request. The service
 * worker derives the origin from the browser-attested sender and checks the
 * rpId against it before anything is minted or signed.
 *
 * adapted from KeePassXC-Browser's passkeys-inject.js pattern.
 */

import { clientDataJson } from './passkey-wire';

const CHANNEL = 'zafu-passkey';

// the wallet answers only after the user reads an origin-first consent screen
// (and possibly unlocks), so give it a generous window; past it the page falls
// back to the platform authenticator rather than hanging forever.
const WALLET_TIMEOUT_MS = 5 * 60_000;

interface WalletResponse {
  success?: boolean;
  error?: string;
  /** machine-readable outcome: 'failed' means the wallet accepted and failed */
  code?: string;
  credentialId?: string;
  authenticatorData?: string;
  publicKey?: string;
  signature?: string;
  prfEnabled?: boolean;
  prfResults?: { first?: string; second?: string };
}

let seq = 0;
const pending = new Map<string, (res: WalletResponse | undefined) => void>();

window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.source !== window) {
    return;
  }
  const data = ev.data as
    | { channel?: string; direction?: string; id?: string; result?: WalletResponse }
    | undefined;
  if (data?.channel !== CHANNEL || data.direction !== 'response' || !data.id) {
    return;
  }
  const settle = pending.get(data.id);
  if (!settle) {
    return;
  }
  pending.delete(data.id);
  settle(data.result);
});

/**
 * Ask the ISOLATED bridge (and through it the service worker). Resolves
 * `undefined` when the wallet cannot answer - no bridge, extension reloaded, or
 * the user never responded - so callers fall back to the platform authenticator.
 */
function askWallet(
  kind: 'create' | 'get',
  payload: Record<string, unknown>,
): Promise<WalletResponse | undefined> {
  const { promise, resolve } = Promise.withResolvers<WalletResponse | undefined>();
  const id = `${Date.now()}-${seq++}`;
  const timer = setTimeout(() => {
    pending.delete(id);
    resolve(undefined);
  }, WALLET_TIMEOUT_MS);
  pending.set(id, res => {
    clearTimeout(timer);
    resolve(res);
  });
  window.postMessage({ channel: CHANNEL, direction: 'request', id, kind, payload }, window.origin);
  return promise;
}

// capture originals before page JS can replace them
const originalCreate = navigator.credentials.create.bind(navigator.credentials);
const originalGet = navigator.credentials.get.bind(navigator.credentials);

/**
 * extract PRF salts from WebAuthn extensions
 */
function extractPrfSalts(
  extensions?: AuthenticationExtensionsClientInputs,
): { first: string; second?: string } | undefined {
  const prf = (extensions as Record<string, unknown>)?.['prf'] as
    | { eval?: { first: BufferSource; second?: BufferSource } }
    | undefined;
  if (!prf?.eval?.first) {
    return undefined;
  }
  return {
    first: bufToHex(prf.eval.first),
    second: prf.eval.second ? bufToHex(prf.eval.second) : undefined,
  };
}

function bufToHex(buf: BufferSource): string {
  const bytes =
    buf instanceof ArrayBuffer
      ? new Uint8Array(buf)
      : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuf(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}

/**
 * The wallet's final word: it took the job and failed (locked mid-flight, an
 * undecryptable vault, a signing error). Such a request MUST NOT fall through
 * to the platform authenticator - the consent screen was already answered, and
 * the browser's own prompt for a passkey that lives in zafu reads to the user
 * as "the wallet stopped working" right after they clicked approve. Every other
 * shape (no answer at all, denied, cancelled, no wallet) keeps the historical
 * fallback, because there zafu genuinely has nothing to offer.
 */
const isWalletFailure = (r: WalletResponse | undefined): boolean => r?.code === 'failed';

/** marks a wallet failure from `askWallet` so the catch below can tell it from an unreachable wallet */
class WalletFailedError extends Error {}

/**
 * wrapped navigator.credentials.create
 */
navigator.credentials.create = async function (
  options?: CredentialCreationOptions,
): Promise<Credential | null> {
  const pk = options?.publicKey;
  if (!pk) {
    return originalCreate(options);
  }

  // check if zafu should handle this
  const rpId = pk.rp?.id ?? window.location.hostname;
  const challenge = bufToHex(pk.challenge);

  try {
    // `origin` is deliberately NOT sent - the service worker derives it from
    // the browser-attested sender and matches the rpId against it.
    const response = await askWallet('create', {
      rpId,
      rpName: pk.rp?.name ?? rpId,
      challenge,
      userName: pk.user?.name ?? '',
      userDisplayName: pk.user?.displayName ?? '',
      userId: pk.user?.id ? bufToHex(pk.user.id) : '',
      prfRequested: !!(pk.extensions as Record<string, unknown>)?.['prf'],
    });

    if (!response?.success) {
      if (isWalletFailure(response)) {
        throw new WalletFailedError(response?.error);
      }
      // zafu declined or was unreachable - fall back to the platform authenticator
      return originalCreate(options);
    }

    // build PublicKeyCredential from zafu's response
    const credentialId = hexToBuf(response.credentialId!);
    const authenticatorData = hexToBuf(response.authenticatorData!);
    const clientDataJSON = clientDataJson(
      'webauthn.create',
      new Uint8Array(hexToBuf(challenge)),
      window.location.origin,
    );

    // construct attestation object (none attestation)
    const attestationObject = buildNoneAttestationObject(authenticatorData);

    return {
      id: btoa(String.fromCharCode(...new Uint8Array(credentialId)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, ''),
      rawId: credentialId,
      type: 'public-key',
      response: {
        clientDataJSON: clientDataJSON.buffer,
        attestationObject: attestationObject.buffer,
        getAuthenticatorData: () => authenticatorData,
        getPublicKey: () => hexToBuf(response.publicKey!),
        getPublicKeyAlgorithm: () => -7, // ES256
        getTransports: () => ['internal'],
      },
      authenticatorAttachment: 'platform',
      getClientExtensionResults: () => {
        const results: Record<string, unknown> = {};
        if (response.prfEnabled) {
          results['prf'] = { enabled: true };
        }
        return results;
      },
    } as unknown as PublicKeyCredential;
  } catch (e) {
    if (e instanceof WalletFailedError) {
      // keep the wallet's own diagnostic off the page - a dapp has no business
      // reading service-worker internals ("keyring locked", "failed to decrypt
      // vault") - but give the user the honest outcome instead of a platform
      // prompt that cannot satisfy a credential zafu owns.
      console.warn('[zafu-passkey] create failed:', e.message);
      throw new DOMException('zafu could not create the passkey', 'NotAllowedError');
    }
    return originalCreate(options);
  }
};

/**
 * wrapped navigator.credentials.get
 */
navigator.credentials.get = async function (
  options?: CredentialRequestOptions,
): Promise<Credential | null> {
  const pk = options?.publicKey;
  if (!pk) {
    return originalGet(options);
  }

  const rpId = pk.rpId ?? window.location.hostname;
  const challenge = bufToHex(pk.challenge);
  const prfSalts = extractPrfSalts(pk.extensions);

  // build clientDataJSON first - the service worker needs its hash to sign
  const clientDataJSON = clientDataJson(
    'webauthn.get',
    new Uint8Array(hexToBuf(challenge)),
    window.location.origin,
  );
  // SHA-256 hash of clientDataJSON - this is what gets signed
  const clientDataHash = bufToHex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON)),
  );

  try {
    const response = await askWallet('get', {
      rpId,
      challenge,
      clientDataHash,
      prfSalts,
      allowCredentials: pk.allowCredentials?.map(c => ({
        id: bufToHex(c.id),
        type: c.type,
      })),
    });

    if (!response?.success) {
      if (isWalletFailure(response)) {
        throw new WalletFailedError(response?.error);
      }
      return originalGet(options);
    }

    const credentialId = hexToBuf(response.credentialId!);
    const authenticatorData = hexToBuf(response.authenticatorData!);
    const signature = hexToBuf(response.signature!);

    return {
      id: btoa(String.fromCharCode(...new Uint8Array(credentialId)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, ''),
      rawId: credentialId,
      type: 'public-key',
      response: {
        clientDataJSON: clientDataJSON.buffer,
        authenticatorData: authenticatorData,
        signature: signature,
        userHandle: null,
      },
      authenticatorAttachment: 'platform',
      getClientExtensionResults: () => {
        const results: Record<string, unknown> = {};
        if (response.prfResults) {
          results['prf'] = {
            results: {
              first: hexToBuf(response.prfResults.first!),
              ...(response.prfResults.second
                ? { second: hexToBuf(response.prfResults.second) }
                : {}),
            },
          };
        }
        return results;
      },
    } as unknown as PublicKeyCredential;
  } catch (e) {
    if (e instanceof WalletFailedError) {
      console.warn('[zafu-passkey] get failed:', e.message);
      throw new DOMException('zafu could not sign in with the passkey', 'NotAllowedError');
    }
    return originalGet(options);
  }
};

/**
 * build CBOR attestation object with fmt:"none"
 */
function buildNoneAttestationObject(authData: ArrayBuffer): Uint8Array {
  const ad = new Uint8Array(authData);
  // CBOR: map(3) { "fmt": "none", "attStmt": {}, "authData": bstr }
  const fmt = new TextEncoder().encode('fmt');
  const none = new TextEncoder().encode('none');
  const attStmt = new TextEncoder().encode('attStmt');
  const authDataKey = new TextEncoder().encode('authData');

  const buf: number[] = [];
  buf.push(0xa3); // map(3)

  // "fmt": "none"
  buf.push(0x63); // tstr(3)
  buf.push(...fmt);
  buf.push(0x64); // tstr(4)
  buf.push(...none);

  // "attStmt": {}
  buf.push(0x67); // tstr(7)
  buf.push(...attStmt);
  buf.push(0xa0); // map(0)

  // "authData": bstr
  buf.push(0x68); // tstr(8)
  buf.push(...authDataKey);
  if (ad.length <= 23) {
    buf.push(0x40 | ad.length);
  } else if (ad.length <= 0xff) {
    buf.push(0x58, ad.length);
  } else {
    buf.push(0x59, (ad.length >> 8) & 0xff, ad.length & 0xff);
  }
  buf.push(...ad);

  return new Uint8Array(buf);
}
