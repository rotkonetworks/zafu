/**
 * AES-256-GCM seal/open over Web Crypto, wire format `nonce(12) || ct || tag`.
 *
 * Shared by the external ZID encryption API (ephemeral-static sealed box) and
 * multisig group chat (static-static authenticated box). The DH and HKDF that
 * produce the key differ per caller; this layer is only the symmetric step, so
 * both callers use the exact same bytes on the wire and there is one place that
 * gets AES-GCM right.
 */

import { randomBytes } from '@noble/hashes/utils';

/** AES-256-GCM encrypt. Returns nonce (12 bytes) || ciphertext || tag. */
export const aesGcmEncrypt = async (key: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> => {
  const nonce = randomBytes(12);
  const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, [
    'encrypt',
  ]);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource },
    cryptoKey,
    plaintext as BufferSource,
  );
  const result = new Uint8Array(12 + encrypted.byteLength);
  result.set(nonce, 0);
  result.set(new Uint8Array(encrypted), 12);
  return result;
};

/** AES-256-GCM decrypt. Input is nonce (12 bytes) || ciphertext || tag. */
export const aesGcmDecrypt = async (key: Uint8Array, data: Uint8Array): Promise<Uint8Array> => {
  if (data.length < 12 + 16) {
    // minimum: 12-byte nonce + 16-byte GCM tag (empty plaintext)
    throw new Error('ciphertext too short');
  }
  const nonce = data.slice(0, 12);
  const ciphertext = data.slice(12);
  const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, [
    'decrypt',
  ]);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource },
    cryptoKey,
    ciphertext as BufferSource,
  );
  return new Uint8Array(decrypted);
};
