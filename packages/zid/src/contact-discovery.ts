/**
 * Private, non-interactive contact discovery — the rendezvous-tag layer.
 *
 * Two friends who hold each other's contact-card key can each compute a shared
 * pairwise ROOT SECRET (identity.ts `zidContactRootSecret`) and, from it, a
 * per-epoch rendezvous TAG with ZERO communication. Presence is published to a
 * blind key-value relay under that tag; the relay learns neither the social
 * graph nor a cross-epoch-linkable identity.
 *
 * This module is deliberately SUITE-BLIND: `rootSecret` is opaque bytes. Whether
 * it came from X25519 DH (today) or an X-Wing / ML-KEM hybrid (later) never
 * reaches here — the PQ migration is localized to establishment in identity.ts.
 *
 * Epoch clock is JAM time (wall-clock, chain-independent) — see below.
 */

import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes } from '@noble/hashes/utils';

// ---------------------------------------------------------------------------
// JAM-time presence epoch
// ---------------------------------------------------------------------------
// Canonical source of these constants: the `jamtime` package
// (rotkonetworks/jamtime v1.1.0, `JAMTime.JAM_COMMON_ERA` / `.SLOT_DURATION`).
// Inlined to avoid a runtime dependency; the values are a drop-in for it.
// JAM time is a fixed-genesis wall-clock slot counter — NOT chain height — so it
// keeps a fixed cadence and needs no chain sync (required by the traffic-analysis
// mitigation and by users not syncing any particular chain).

/** JAM Common Era: 2025-01-01 12:00:00 UTC, in unix seconds. */
export const JAM_COMMON_ERA = 1735732800;
/** JAM timeslot duration, seconds. */
export const JAM_SLOT_DURATION = 6;
/**
 * JAM timeslots per presence epoch. 50 × 6s = 300s = 5 min. The single tunable:
 * shorter = fresher presence + more relay churn + shorter linkage window.
 */
export const PRESENCE_EPOCH_SLOTS = 50;

/** current JAM timeslot from the wall clock. */
export const jamTimeslot = (unixSeconds: number = Date.now() / 1000): number =>
  Math.floor((unixSeconds - JAM_COMMON_ERA) / JAM_SLOT_DURATION);

/** current presence epoch (grouped JAM timeslots). Both parties agree from their clock. */
export const presenceEpoch = (unixSeconds?: number): number =>
  Math.floor(jamTimeslot(unixSeconds) / PRESENCE_EPOCH_SLOTS);

// ---------------------------------------------------------------------------
// Rendezvous tag
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

const u32be = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
};

const concatBytes = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};

/** rendezvous tag length, bytes. */
export const RENDEZVOUS_TAG_BYTES = 16;

/**
 * Non-interactive rendezvous tag under which `publisherPubHex` announces
 * presence to the holder of the pairwise `rootSecret`, for `appOrigin` at
 * `epoch`. Both sides derive it identically from public inputs + the shared
 * secret, with zero communication.
 *
 * Direction is encoded by WHOSE contact-card pubkey is in the tag (the
 * publisher's), not an ordering convention — so to FIND friend j you compute the
 * tag with j's pubkey; to ANNOUNCE yourself you publish under your own.
 *
 * Domain separation is unambiguous: every field is hashed/encoded to a fixed
 * length, so no field can be confused for another regardless of input length or
 * KA suite (the publisher pub is hashed, so a hybrid's longer key still fits).
 *
 * NOTE ON FORWARD SECRECY (design decision A, accepted): epoch-in-KDF gives
 * cross-epoch UNLINKABILITY but NOT forward secrecy, and there is no cheap
 * ratchet that would add it here. The `rootSecret` is a STATIC NIKE output
 * (X25519 DH of two long-term contact-KA keys), so it is deterministically
 * recomputable from those keys — a future compromise of the contact-KA key (or
 * mnemonic) plus logged relay transcripts recovers every past epoch's tags/blobs
 * regardless of any hash-ratchet (the attacker just re-derives the base and
 * ratchets forward). This is accepted for presence metadata. The bounded
 * mitigation (fast-follow) is PERIODIC CONTACT-KA KEY ROTATION with old-key
 * deletion (like the per-site ZID rotation index), which caps exposure to the
 * window since the last rotation. See docs/zid-contact-discovery.md.
 */
export const rendezvousTag = (
  rootSecret: Uint8Array,
  appOrigin: string,
  epoch: number,
  publisherPubHex: string,
): Uint8Array => {
  const info = concatBytes(
    enc.encode('zid-rvz-v1'),
    sha256(enc.encode(appOrigin)), // fixed 32
    u32be(epoch), // fixed 4
    sha256(hexToBytes(publisherPubHex)), // fixed 32, suite-agnostic pub length
  );
  return hkdf(sha256, rootSecret, undefined, info, RENDEZVOUS_TAG_BYTES);
};
