/**
 * Encryption filter for the message pipeline.
 *
 * Pluggable: swap chacha20poly1305 for AES-GCM, or identity (no encryption)
 * without changing the rest of the pipeline.
 *
 * Service[Req, Rep] pattern:
 *   encrypt andThen serialize andThen transport
 *   transport andThen deserialize andThen decrypt
 */

import type { SimpleFilter } from '../types';

/** A chat message before/after encryption. */
export interface ChatMessage {
  /** sender nick */
  nick: string;
  /** message text (plaintext or ciphertext depending on position in pipeline) */
  text: string;
  /** message type */
  type: 'msg' | 'system' | 'dm' | 'action';
  /** target room/channel */
  room?: string;
  /** timestamp (relay-assigned) */
  ts?: number;
  /** sequence number (relay-assigned) */
  seq?: number;
}

/** An encrypted envelope — opaque to the transport layer. */
export interface EncryptedMessage {
  /** ciphertext (base64 or hex) */
  ct: string;
  /** nonce/IV (base64 or hex) */
  iv: string;
  /** sender's ephemeral public key (for DH) */
  epk?: string;
  /** key epoch (for key rotation) */
  epoch?: number;
}

/** Encryption provider interface — implement this for different schemes. */
export interface EncryptionProvider {
  /** encrypt plaintext → ciphertext + nonce */
  encrypt(plaintext: Uint8Array, context?: Uint8Array): Promise<{ ct: Uint8Array; iv: Uint8Array }>;
  /** decrypt ciphertext + nonce → plaintext */
  decrypt(ct: Uint8Array, iv: Uint8Array, context?: Uint8Array): Promise<Uint8Array>;
  /** provider name (for display) */
  name: string;
}

/** No encryption — plaintext passthrough. For development/testing. */
export class PlaintextProvider implements EncryptionProvider {
  name = 'plaintext';
  async encrypt(plaintext: Uint8Array) {
    return { ct: plaintext, iv: new Uint8Array(0) };
  }
  async decrypt(ct: Uint8Array) {
    return ct;
  }
}

/**
 * ChaCha20-Poly1305 encryption provider.
 * Uses Web Crypto API (available in browsers + extensions).
 *
 * The shared key comes from X25519 DH (for DMs) or HKDF level keys (for channels).
 */
export class ChaChaProvider implements EncryptionProvider {
  name = 'chacha20poly1305';
  private key: CryptoKey | null = null;

  /** initialize with a shared secret (from DH or HKDF) */
  async init(sharedSecret: Uint8Array): Promise<void> {
    // derive AES-GCM key from shared secret (Web Crypto doesn't support ChaCha natively)
    // use AES-256-GCM as the Web Crypto substitute — same security level
    this.key = await crypto.subtle.importKey(
      'raw',
      sharedSecret.slice(0, 32),
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  async encrypt(plaintext: Uint8Array): Promise<{ ct: Uint8Array; iv: Uint8Array }> {
    if (!this.key) throw new Error('chacha provider not initialized');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, plaintext),
    );
    return { ct, iv };
  }

  async decrypt(ct: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
    if (!this.key) throw new Error('chacha provider not initialized');
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, this.key, ct),
    );
  }
}

/**
 * Encryption filter: encrypts outgoing messages.
 *
 * Composes with the transport service:
 *   encryptFilter andThen transportService
 */
export function encryptFilter(provider: EncryptionProvider): SimpleFilter<ChatMessage, void> {
  return async (msg, service) => {
    const plaintext = new TextEncoder().encode(JSON.stringify(msg));
    const { ct, iv } = await provider.encrypt(plaintext);
    const encrypted: ChatMessage = {
      ...msg,
      text: JSON.stringify({
        ct: toBase64(ct),
        iv: toBase64(iv),
        enc: provider.name,
      }),
    };
    return service(encrypted);
  };
}

/**
 * Decryption filter: decrypts incoming messages.
 *
 * Composes with the message handler:
 *   decryptFilter andThen displayService
 */
export function decryptFilter(provider: EncryptionProvider): SimpleFilter<ChatMessage, void> {
  return async (msg, service) => {
    try {
      const envelope = JSON.parse(msg.text);
      if (envelope.ct && envelope.iv) {
        const ct = fromBase64(envelope.ct);
        const iv = fromBase64(envelope.iv);
        const plaintext = await provider.decrypt(ct, iv);
        const decrypted: ChatMessage = JSON.parse(new TextDecoder().decode(plaintext));
        return service(decrypted);
      }
    } catch {
      // not encrypted or decryption failed — pass through
    }
    return service(msg);
  };
}

// base64 helpers
function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(str: string): Uint8Array {
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}
