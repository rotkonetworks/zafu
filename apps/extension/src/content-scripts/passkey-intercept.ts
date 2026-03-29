/**
 * passkey intercept — wraps navigator.credentials to offer zafu as authenticator.
 *
 * injected at document_start (before page JS can cache the original API).
 * communicates with service worker via chrome.runtime.sendMessage.
 * page JS cannot intercept the communication channel.
 *
 * adapted from KeePassXC-Browser's passkeys-inject.js pattern.
 */

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
  if (!prf?.eval?.first) return undefined;
  return {
    first: bufToHex(prf.eval.first),
    second: prf.eval.second ? bufToHex(prf.eval.second) : undefined,
  };
}

function bufToHex(buf: BufferSource): string {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuf(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  return bytes.buffer;
}

/**
 * wrapped navigator.credentials.create
 */
navigator.credentials.create = async function (
  options?: CredentialCreationOptions,
): Promise<Credential | null> {
  const pk = options?.publicKey;
  if (!pk) return originalCreate(options);

  // check if zafu should handle this
  const rpId = pk.rp?.id ?? window.location.hostname;
  const challenge = bufToHex(pk.challenge);

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'zafu_passkey_create',
      rpId,
      rpName: pk.rp?.name ?? rpId,
      challenge,
      origin: window.location.origin,
      userName: pk.user?.name ?? '',
      userDisplayName: pk.user?.displayName ?? '',
      userId: pk.user?.id ? bufToHex(pk.user.id) : '',
      prfRequested: !!(pk.extensions as Record<string, unknown>)?.['prf'],
    });

    if (!response?.success) {
      // zafu declined — fall back to platform authenticator
      return originalCreate(options);
    }

    // build PublicKeyCredential from zafu's response
    const credentialId = hexToBuf(response.credentialId);
    const authenticatorData = hexToBuf(response.authenticatorData);
    const clientDataJSON = new TextEncoder().encode(JSON.stringify({
      type: 'webauthn.create',
      challenge: btoa(String.fromCharCode(...new Uint8Array(hexToBuf(challenge))))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''),
      origin: window.location.origin,
      crossOrigin: false,
    }));

    // construct attestation object (none attestation)
    const attestationObject = buildNoneAttestationObject(authenticatorData);

    return {
      id: btoa(String.fromCharCode(...new Uint8Array(credentialId)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''),
      rawId: credentialId,
      type: 'public-key',
      response: {
        clientDataJSON: clientDataJSON.buffer,
        attestationObject: attestationObject.buffer,
        getAuthenticatorData: () => authenticatorData,
        getPublicKey: () => hexToBuf(response.publicKey),
        getPublicKeyAlgorithm: () => -7, // ES256
        getTransports: () => ['internal'],
      },
      authenticatorAttachment: 'platform',
      getClientExtensionResults: () => {
        const results: Record<string, unknown> = {};
        if (response.prfEnabled) results['prf'] = { enabled: true };
        return results;
      },
    } as unknown as PublicKeyCredential;
  } catch {
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
  if (!pk) return originalGet(options);

  const rpId = pk.rpId ?? window.location.hostname;
  const challenge = bufToHex(pk.challenge);
  const prfSalts = extractPrfSalts(pk.extensions);

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'zafu_passkey_get',
      rpId,
      challenge,
      origin: window.location.origin,
      prfSalts,
      allowCredentials: pk.allowCredentials?.map(c => ({
        id: bufToHex(c.id),
        type: c.type,
      })),
    });

    if (!response?.success) {
      return originalGet(options);
    }

    const credentialId = hexToBuf(response.credentialId);
    const authenticatorData = hexToBuf(response.authenticatorData);
    const signature = hexToBuf(response.signature);
    const clientDataJSON = new TextEncoder().encode(JSON.stringify({
      type: 'webauthn.get',
      challenge: btoa(String.fromCharCode(...new Uint8Array(hexToBuf(challenge))))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''),
      origin: window.location.origin,
      crossOrigin: false,
    }));

    return {
      id: btoa(String.fromCharCode(...new Uint8Array(credentialId)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''),
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
              first: hexToBuf(response.prfResults.first),
              ...(response.prfResults.second ? { second: hexToBuf(response.prfResults.second) } : {}),
            },
          };
        }
        return results;
      },
    } as unknown as PublicKeyCredential;
  } catch {
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
