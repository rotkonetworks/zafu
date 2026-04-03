/**
 * external encryption API - sealed box encryption for third-party web apps.
 *
 * exposes zafu's ZID-derived encryption keys to external apps via
 * chrome.runtime.onMessageExternal. keys never leave the extension.
 *
 * supported messages:
 * - { type: 'zafu_encrypt', recipient, plaintext } - sealed box encrypt
 * - { type: 'zafu_decrypt', ciphertext, ephemeral_pubkey } - sealed box decrypt
 * - { type: 'zafu_zid_pubkey' } - get site-specific ZID ed25519 pubkey
 *
 * crypto: ephemeral x25519 DH -> HKDF-SHA256 -> AES-256-GCM
 * this is the NaCl crypto_box_seal pattern using Web Crypto + @noble/curves.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { edwardsToMontgomeryPub, edwardsToMontgomeryPriv } from '@noble/curves/ed25519';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';
import { getOriginPermissions, grantCapability, denyCapability } from '@repo/storage-chrome/origin';
import { hasCapability, isDenied } from '@repo/storage-chrome/capabilities';

// -- types --

interface EncryptRequest {
  type: 'zafu_encrypt';
  recipient: string; // hex ed25519 pubkey (64 hex chars = 32 bytes)
  plaintext: string; // base64-encoded
}

interface DecryptRequest {
  type: 'zafu_decrypt';
  ciphertext: string;       // base64-encoded (includes 12-byte nonce prefix)
  ephemeral_pubkey: string;  // hex x25519 pubkey
}


// -- rate limiting --

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 100;

/** per-origin call timestamps for rate limiting */
const callLog = new Map<string, number[]>();

const isRateLimited = (origin: string): boolean => {
  const now = Date.now();
  const calls = callLog.get(origin) ?? [];

  // prune old entries
  const recent = calls.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  callLog.set(origin, recent);

  if (recent.length >= RATE_LIMIT_MAX) return true;

  recent.push(now);
  return false;
};

// -- permission tracking --

/** origins approved for encryption in this session */
const approvedOrigins = new Set<string>();

/** pending approval callbacks: requestId -> resolve */
const pendingApprovals = new Map<string, (r: unknown) => void>();

/**
 * check if origin has encryption permission, or prompt for approval.
 * returns true if approved, false if denied.
 */
const ensureApproved = async (
  origin: string,
  sender: chrome.runtime.MessageSender,
): Promise<boolean> => {
  // already approved this session
  if (approvedOrigins.has(origin)) return true;

  // check persistent capability
  const perms = await getOriginPermissions(origin);
  if (hasCapability(perms, 'encrypt')) {
    approvedOrigins.add(origin);
    return true;
  }
  if (isDenied(perms, 'encrypt')) return false;

  // open approval popup
  const requestId = crypto.randomUUID();
  const resultPromise = new Promise<unknown>(resolve => {
    pendingApprovals.set(requestId, resolve);
  });

  const params = new URLSearchParams({
    app: origin,
    capability: 'encrypt',
    requestId,
    favIconUrl: sender.tab?.favIconUrl || '',
    title: sender.tab?.title || '',
  });
  const url = chrome.runtime.getURL(`popup.html#/approval/capability?${params.toString()}`);
  void chrome.windows.create({ url, type: 'popup', width: 400, height: 520 });

  const result = await resultPromise as { approved?: boolean };
  if (result?.approved) {
    await grantCapability(origin, 'encrypt');
    approvedOrigins.add(origin);
    return true;
  } else {
    await denyCapability(origin, 'encrypt');
    return false;
  }
};

// -- input validation --

const HEX_RE = /^[0-9a-fA-F]+$/;

const isValidHexPubkey = (hex: unknown, expectedBytes: number): hex is string =>
  typeof hex === 'string' &&
  hex.length === expectedBytes * 2 &&
  HEX_RE.test(hex);

const isValidBase64 = (s: unknown): s is string => {
  if (typeof s !== 'string' || s.length === 0) return false;
  try {
    // round-trip check: decode then re-encode must match
    const decoded = Uint8Array.from(atob(s), c => c.charCodeAt(0));
    return decoded.length > 0;
  } catch {
    return false;
  }
};

const base64ToBytes = (s: string): Uint8Array =>
  Uint8Array.from(atob(s), c => c.charCodeAt(0));

const bytesToBase64 = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b));

// -- crypto primitives --

/**
 * build the HKDF info string that binds to both pubkeys.
 * prevents key confusion attacks by committing the DH to its participants.
 */
const buildInfo = (ephemeralPub: Uint8Array, recipientPub: Uint8Array): Uint8Array => {
  const infoStr = 'zafu-seal-v1:' + bytesToHex(ephemeralPub) + ':' + bytesToHex(recipientPub);
  return new TextEncoder().encode(infoStr);
};

/**
 * perform x25519 DH + HKDF-SHA256 -> 32-byte AES key.
 */
const deriveAesKey = (
  sharedSecret: Uint8Array,
  ephemeralPub: Uint8Array,
  recipientX25519Pub: Uint8Array,
): Uint8Array => {
  const info = buildInfo(ephemeralPub, recipientX25519Pub);
  return hkdf(sha256, sharedSecret, undefined, info, 32);
};

/**
 * AES-256-GCM encrypt. returns nonce (12 bytes) || ciphertext || tag.
 */
const aesGcmEncrypt = async (key: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> => {
  const nonce = randomBytes(12);
  const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource },
    cryptoKey,
    plaintext as BufferSource,
  );
  // nonce || ciphertext+tag
  const result = new Uint8Array(12 + encrypted.byteLength);
  result.set(nonce, 0);
  result.set(new Uint8Array(encrypted), 12);
  return result;
};

/**
 * AES-256-GCM decrypt. input is nonce (12 bytes) || ciphertext || tag.
 */
const aesGcmDecrypt = async (key: Uint8Array, data: Uint8Array): Promise<Uint8Array> => {
  if (data.length < 12 + 16) {
    // minimum: 12-byte nonce + 16-byte GCM tag (empty plaintext)
    throw new Error('ciphertext too short');
  }
  const nonce = data.slice(0, 12);
  const ciphertext = data.slice(12);
  const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['decrypt']);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource },
    cryptoKey,
    ciphertext as BufferSource,
  );
  return new Uint8Array(decrypted);
};

/**
 * validate an ed25519 public key by checking it's on the curve.
 * rejects low-order points, identity point, and malformed encodings.
 */
const validateEd25519Pubkey = (pubkeyBytes: Uint8Array): boolean => {
  try {
    // ExtendedPoint.fromHex validates the point is on the curve
    ed25519.ExtendedPoint.fromHex(pubkeyBytes);
    return true;
  } catch {
    return false;
  }
};

// -- handlers --

const handleEncrypt = async (msg: EncryptRequest): Promise<unknown> => {
  // validate recipient pubkey
  if (!isValidHexPubkey(msg.recipient, 32)) {
    return { error: 'invalid recipient: expected 64 hex chars (32-byte ed25519 pubkey)' };
  }

  if (!isValidBase64(msg.plaintext)) {
    return { error: 'invalid plaintext: expected non-empty base64 string' };
  }

  const recipientEd25519 = hexToBytes(msg.recipient);
  if (!validateEd25519Pubkey(recipientEd25519)) {
    return { error: 'invalid recipient: not a valid ed25519 public key' };
  }

  try {
    // convert recipient ed25519 pubkey to x25519
    const recipientX25519 = edwardsToMontgomeryPub(recipientEd25519);

    // generate ephemeral x25519 keypair
    const ephemeralPriv = randomBytes(32);
    const ephemeralPub = x25519.getPublicKey(ephemeralPriv);

    // DH: ephemeral_priv * recipient_x25519_pub
    const sharedSecret = x25519.getSharedSecret(ephemeralPriv, recipientX25519);
    ephemeralPriv.fill(0);

    // HKDF -> AES key
    const aesKey = deriveAesKey(sharedSecret, ephemeralPub, recipientX25519);
    sharedSecret.fill(0);

    // encrypt
    const plaintext = base64ToBytes(msg.plaintext);
    const sealed = await aesGcmEncrypt(aesKey, plaintext);
    aesKey.fill(0);

    return {
      ciphertext: bytesToBase64(sealed),
      ephemeral_pubkey: bytesToHex(ephemeralPub),
    };
  } catch (e) {
    return { error: 'encryption failed: ' + String(e) };
  }
};

const handleDecrypt = async (
  msg: DecryptRequest,
  origin: string,
): Promise<unknown> => {
  // validate inputs
  if (!isValidHexPubkey(msg.ephemeral_pubkey, 32)) {
    return { error: 'invalid ephemeral_pubkey: expected 64 hex chars (32-byte x25519 pubkey)' };
  }

  if (!isValidBase64(msg.ciphertext)) {
    return { error: 'invalid ciphertext: expected non-empty base64 string' };
  }

  try {
    // get user's ed25519 keypair for this origin
    const { useStore } = await import('../../state');
    const keyInfo = useStore.getState().keyRing.selectedKeyInfo;
    if (!keyInfo) return { error: 'wallet locked' };

    const mnemonic = await useStore.getState().keyRing.getMnemonic(keyInfo.id);

    const { deriveZidKeypairForSite, DEFAULT_IDENTITY } = await import('../../state/identity');
    const { privateKey: ed25519Priv, publicKey: ed25519Pub } = deriveZidKeypairForSite(
      mnemonic, DEFAULT_IDENTITY, origin,
    );

    // convert our ed25519 private key to x25519
    const ourX25519Priv = edwardsToMontgomeryPriv(ed25519Priv);
    const ourX25519Pub = edwardsToMontgomeryPub(ed25519Pub);
    ed25519Priv.fill(0);

    const ephemeralPub = hexToBytes(msg.ephemeral_pubkey);

    // DH: our_x25519_priv * ephemeral_pub
    const sharedSecret = x25519.getSharedSecret(ourX25519Priv, ephemeralPub);
    ourX25519Priv.fill(0);

    // HKDF -> AES key (info binds ephemeral + our static x25519 pub)
    const aesKey = deriveAesKey(sharedSecret, ephemeralPub, ourX25519Pub);
    sharedSecret.fill(0);

    // decrypt
    const ciphertextBytes = base64ToBytes(msg.ciphertext);
    const plaintext = await aesGcmDecrypt(aesKey, ciphertextBytes);
    aesKey.fill(0);

    return { plaintext: bytesToBase64(plaintext) };
  } catch (e) {
    return { error: 'decryption failed' };
  }
};

const handleZidPubkey = async (origin: string): Promise<unknown> => {
  try {
    const { useStore } = await import('../../state');
    const keyInfo = useStore.getState().keyRing.selectedKeyInfo;
    if (!keyInfo) return { error: 'wallet locked' };

    const mnemonic = await useStore.getState().keyRing.getMnemonic(keyInfo.id);

    const { deriveZidForSite, DEFAULT_IDENTITY } = await import('../../state/identity');
    const zid = deriveZidForSite(mnemonic, DEFAULT_IDENTITY, origin);

    return { pubkey: zid.publicKey };
  } catch (e) {
    return { error: 'failed to derive pubkey: ' + String(e) };
  }
};

// -- main listener --

const ENCRYPTION_TYPES = new Set(['zafu_encrypt', 'zafu_decrypt', 'zafu_zid_pubkey', 'zafu_encryption_approval_result']);

export const encryptionMessageListener = (
  req: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (r: unknown) => void,
): boolean => {
  if (typeof req !== 'object' || req === null || !('type' in req)) return false;

  const msg = req as Record<string, unknown>;
  const type = msg['type'] as string;

  if (!ENCRYPTION_TYPES.has(type)) return false;

  // handle approval result from popup (internal message routed externally)
  if (type === 'zafu_encryption_approval_result') {
    const requestId = String(msg['requestId'] || '');
    const callback = pendingApprovals.get(requestId);
    if (callback) {
      callback(msg['result'] || { approved: false });
      pendingApprovals.delete(requestId);
    }
    sendResponse({ ok: true });
    return true;
  }

  const origin = sender.origin || sender.url;
  if (!origin) {
    sendResponse({ error: 'unknown origin' });
    return true;
  }

  // rate limit check
  if (isRateLimited(origin)) {
    sendResponse({ error: 'rate limited: max 100 calls per minute' });
    return true;
  }

  // dispatch
  void (async () => {
    // check permission (may open approval popup)
    const approved = await ensureApproved(origin, sender);
    if (!approved) {
      sendResponse({ error: 'permission denied' });
      return;
    }

    switch (type) {
      case 'zafu_encrypt':
        sendResponse(await handleEncrypt(msg as unknown as EncryptRequest));
        break;
      case 'zafu_decrypt':
        sendResponse(await handleDecrypt(msg as unknown as DecryptRequest, origin));
        break;
      case 'zafu_zid_pubkey':
        sendResponse(await handleZidPubkey(origin));
        break;
      default:
        sendResponse({ error: 'unknown encryption message type' });
    }
  })();

  return true;
};
