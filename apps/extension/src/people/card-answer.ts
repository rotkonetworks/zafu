/**
 * An answer to a card, sealed to the card's pair key (security review 3).
 *
 * A card's room is derived from the card alone, so whoever holds the link
 * can read it. An answer carries the answerer's name and the address made
 * for this one person, so it travels in a box only the card's maker opens:
 * an ephemeral X25519 key against the card's `pairKa`, HKDF-SHA256, then
 * AES-256-GCM with the card's key as associated data.
 *
 *   body   zp2:card-sealed:<base64url box>
 *   box    ver 0x01 || ephemeral pub 32 || nonce 12 || ciphertext + tag
 *
 * The box hides the answer; it does not say who sent it. Anyone holding the
 * link can still seal an answer to the card, so the maker compares the seal
 * before the person is saved, and chooses when more than one arrives.
 *
 * A card says it reads sealed answers with `Cap.sealed`; an answer to an
 * older card goes plain (`zp2:card:`), and reads as "not sealed".
 */

import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { hexToBytes } from '@noble/hashes/utils';
import { cardB64, fromB64url } from '@repo/wallet/networks/zcash/card-v2';

export const SEALED_BODY = 'zp2:card-sealed:';
const VER = 0x01;
const EPK = 32;
const NONCE = 12;
const enc = new TextEncoder();
/** bytes WebCrypto takes: a copy on a plain ArrayBuffer */
const own = (b: Uint8Array) => new Uint8Array(b);

const keyFor = async (
  shared: Uint8Array,
  cardKey: Uint8Array,
  epk: Uint8Array,
  pairKa: Uint8Array,
): Promise<CryptoKey> => {
  const raw = hkdf(
    sha256,
    shared,
    enc.encode('zafu-card-answer-v1'),
    new Uint8Array([...cardKey, ...epk, ...pairKa]),
    32,
  );
  const copy = own(raw);
  try {
    return await crypto.subtle.importKey('raw', copy, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } finally {
    raw.fill(0);
    copy.fill(0);
    shared.fill(0);
  }
};

/** the answer's signed bytes, sealed to the card it answers */
export const sealAnswer = async (
  card: { key: string; pairKa: string },
  answer: Uint8Array,
): Promise<string> => {
  const eph = x25519.utils.randomPrivateKey();
  const epk = x25519.getPublicKey(eph);
  const pairKa = hexToBytes(card.pairKa);
  const cardKey = hexToBytes(card.key);
  const key = await keyFor(x25519.getSharedSecret(eph, pairKa), cardKey, epk, pairKa);
  eph.fill(0);
  const iv = crypto.getRandomValues(new Uint8Array(NONCE));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: own(cardKey) },
      key,
      own(answer),
    ),
  );
  return SEALED_BODY + cardB64(new Uint8Array([VER, ...epk, ...iv, ...ct]));
};

/** the answer inside a sealed body, with the card maker's pair secret; null when it does not open */
export const openAnswer = async (
  card: { key: string; pairKa: string },
  kaSeed: Uint8Array,
  body: string,
): Promise<Uint8Array | null> => {
  if (!body.startsWith(SEALED_BODY)) {
    return null;
  }
  try {
    const box = fromB64url(body.slice(SEALED_BODY.length));
    if (box[0] !== VER || box.length < 1 + EPK + NONCE + 16) {
      return null;
    }
    const epk = box.subarray(1, 1 + EPK);
    const iv = box.subarray(1 + EPK, 1 + EPK + NONCE);
    const cardKey = hexToBytes(card.key);
    const pairKa = hexToBytes(card.pairKa);
    const key = await keyFor(x25519.getSharedSecret(kaSeed, epk), cardKey, epk, pairKa);
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: own(iv), additionalData: own(cardKey) },
        key,
        own(box.subarray(1 + EPK + NONCE)),
      ),
    );
  } catch {
    return null;
  }
};
