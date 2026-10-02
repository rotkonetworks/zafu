/**
 * Getting the vault key to the zcash worker without exposing it on the way.
 *
 * The worker cannot read chrome.storage, and calls to it may cross the
 * extension message bus (popup -> runtime -> offscreen host -> Worker), where
 * every listening context sees the payload. So for each operation the worker
 * issues a single-use ECDH P-256 key; the page wraps the session key to it
 * (ECDH -> HKDF -> AES-GCM key wrap) and sends only the wrapped key and the
 * vault's sealed box. Nothing on the bus opens without the worker's one-time
 * private key, which never leaves the worker, and the unwrapped key is a
 * non-extractable, decrypt-only CryptoKey that is dropped after the send.
 */
import { base64ToUint8Array, uint8ArrayToBase64 } from '@penumbrafi/types/base64';
import type { KeyJson } from '@repo/encryption/key';

/** a single-use key the worker issued for one operation */
export interface WorkerKey {
  id: string;
  /** raw uncompressed P-256 public key, base64 */
  pub: string;
}

/** the session key, wrapped to one WorkerKey */
export interface KeySeal {
  id: string;
  /** the page's ephemeral P-256 public key, base64 */
  epk: string;
  nonce: string;
  wrapped: string;
}

/** what crosses to the worker for a hot operation: two ciphertexts */
export interface SealedVault {
  box: string;
  seal: KeySeal;
}

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const INFO = new TextEncoder().encode('zafu vault key seal v1');

/** AES-GCM key for one seal, bound to the worker key id */
const sealKey = async (priv: CryptoKey, pub: CryptoKey, id: string, usage: KeyUsage) => {
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(id), info: INFO },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
};

const raw = async (pub: CryptoKey) =>
  uint8ArrayToBase64(new Uint8Array(await crypto.subtle.exportKey('raw', pub)));

const importPub = (b64: string) =>
  crypto.subtle.importKey('raw', base64ToUint8Array(b64) as BufferSource, ECDH, false, []);

// ── worker side ──

/** issued keys awaiting their seal; each is used at most once */
const issued = new Map<string, CryptoKey>();
const ISSUED_TTL_MS = 120_000;

export const issueWorkerKey = async (): Promise<WorkerKey> => {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(ECDH, false, ['deriveBits']);
  const id = uint8ArrayToBase64(crypto.getRandomValues(new Uint8Array(16)));
  issued.set(id, privateKey);
  setTimeout(() => issued.delete(id), ISSUED_TTL_MS);
  return { id, pub: await raw(publicKey) };
};

/** the session key as a decrypt-only CryptoKey, or null; the issued key is spent either way */
export const openKeySeal = async (seal: KeySeal): Promise<CryptoKey | null> => {
  const priv = issued.get(seal.id);
  issued.delete(seal.id);
  if (!priv) {
    return null;
  }
  try {
    const unwrapKey = await sealKey(priv, await importPub(seal.epk), seal.id, 'unwrapKey');
    return await crypto.subtle.unwrapKey(
      'jwk',
      base64ToUint8Array(seal.wrapped) as BufferSource,
      unwrapKey,
      { name: 'AES-GCM', iv: base64ToUint8Array(seal.nonce) as BufferSource },
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
  } catch {
    return null;
  }
};

// ── page side ──

/** wrap the session key to a worker-issued key */
export const sealKeyTo = async (keyJson: KeyJson, to: WorkerKey): Promise<KeySeal> => {
  const key = await crypto.subtle.importKey('jwk', keyJson._inner, 'AES-GCM', true, ['decrypt']);
  const mine = await crypto.subtle.generateKey(ECDH, false, ['deriveBits']);
  const wrapKey = await sealKey(mine.privateKey, await importPub(to.pub), to.id, 'wrapKey');
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.wrapKey('jwk', key, wrapKey, { name: 'AES-GCM', iv: nonce });
  return {
    id: to.id,
    epk: await raw(mine.publicKey),
    nonce: uint8ArrayToBase64(nonce),
    wrapped: uint8ArrayToBase64(new Uint8Array(wrapped)),
  };
};
