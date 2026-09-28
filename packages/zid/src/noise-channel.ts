/**
 * Hybrid post-quantum Noise IK channel between two ZID identities.
 *
 * Protocol: zafuNoise_IKhybrid_25519+MLKEM768_ChaChaPoly_SHA256
 *
 * The classical Noise_IK_25519 handshake with an EPHEMERAL ML-KEM-768 shared
 * secret mixed into the chaining key as the final step, so the transport keys
 * depend on BOTH the X25519 chain and the ML-KEM secret. A passive attacker who
 * records the traffic today must break BOTH X25519 and ML-KEM to decrypt it -
 * that is the harvest-now-decrypt-later defense. The ML-KEM key is ephemeral
 * (fresh per handshake), so the post-quantum secret is also forward-secret.
 * Authentication is unchanged: the X25519 static DHs (es/ss/se) still bind the
 * parties' identities; ML-KEM only adds confidentiality.
 *
 * Handshake pattern (IK + hybrid):
 *   <- s                       (responder static known a priori)
 *   ...
 *   -> e, e_pq, es, s, ss      (initiator sends noise_init 0x01)
 *   <- e, e_pq(ct), ee, se     (responder sends noise_resp 0x02)
 *   [both mix the ML-KEM shared secret last, then split]
 *
 * After handshake: two CipherState objects (send/recv) with independent keys.
 * Transport: ChaChaPoly1305 with monotonic 8-byte BE counter nonces (0x03 prefix).
 *
 * Wire format:
 *   0x01 noise_init  - [tag][e 32][mlkem_ek 1184][encrypted s 48][encrypted payload 16+]
 *   0x02 noise_resp  - [tag][e 32][mlkem_ct 1088][encrypted payload 16+]
 *   0x03 noise_transport - [tag][counter BE 8][ciphertext+tag]
 *   0x04 noise_refuse    - [tag][u16 BE name len][utf8 protocol name] (peer cannot
 *                          speak this protocol; the one downgrade-eligible signal)
 *
 * These messages ride the relay WebSocket (no 512-byte memo limit); the memo is
 * only a classical bootstrap pointer. The relay routes by (from, to) pubkey pair
 * and sees the envelope, never the Noise payloads. The distinct protocol name
 * makes a hybrid peer and a classical (old) peer fail the handshake rather than
 * silently fall back to a classical-only key.
 */

import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519, ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import { extract, expand } from '@noble/hashes/hkdf';
import {
  mlkem768KeygenEphemeral,
  mlkem768Encapsulate,
  mlkem768Decapsulate,
  MLKEM768_LENGTHS,
} from '@zafu/pq';
import type { ZidChannel } from './types';

// -- constants --

const NOISE_INIT = 0x01;
const NOISE_RESP = 0x02;
const NOISE_TRANSPORT = 0x03;
// responder -> initiator: "I do not speak your protocol"; names the one it
// speaks instead. The ONLY well-formed signal an `'auto'` caller may downgrade
// on (see encodeProtocolRefusal).
const NOISE_REFUSE = 0x04;

// Hybrid IK: the classical Noise_IK_25519 handshake with an ephemeral ML-KEM-768
// shared secret mixed into the chaining key, so recorded traffic stays
// confidential against a future quantum attacker (harvest-now-decrypt-later).
// The distinct protocol name means a hybrid peer and a classical (old) peer
// derive different initial state and the handshake FAILS CLOSED - never a silent
// downgrade to the classical-only key.
const PROTOCOL_NAME = 'zafuNoise_IKhybrid_25519+MLKEM768_ChaChaPoly_SHA256';

/** ephemeral ML-KEM-768 encapsulation key, carried in the init message. */
const MLKEM_EK_LEN = MLKEM768_LENGTHS.publicKey; // 1184
/** ML-KEM-768 ciphertext, carried in the resp message. */
const MLKEM_CT_LEN = MLKEM768_LENGTHS.cipherText; // 1088

const EMPTY = new Uint8Array(0);
const TAG_LEN = 16;

// Minimum well-formed message lengths, for an up-front guard (defense in depth -
// a malformed message would already fail closed via the @zafu/pq length asserts
// and the AEAD, but an explicit check gives a clean error at the boundary):
//   init: 0x01 + e(32) + mlkem_ek(1184) + encStatic(32+tag) + encPayload(tag)
const NOISE_INIT_MIN_LEN = 1 + 32 + MLKEM_EK_LEN + (32 + TAG_LEN) + TAG_LEN; // 1281
//   resp: 0x02 + e(32) + mlkem_ct(1088) + encPayload(tag)
const NOISE_RESP_MIN_LEN = 1 + 32 + MLKEM_CT_LEN + TAG_LEN; // 1137

// -- types --

export interface SessionKey {
  pubkey: string; // hex ed25519 public key
  privkey: Uint8Array; // ed25519 seed (32 bytes) - required for x25519 DH
  sign: (data: Uint8Array) => Promise<string>; // returns hex signature
}

export interface CipherState {
  k: Uint8Array; // 32-byte symmetric key
  n: bigint; // monotonic counter nonce
}

/** the initiator's in-flight hybrid handshake (before the responder's resp). */
export interface InitiatorHandshake {
  /** the noise_init message to send (0x01). */
  message: Uint8Array;
  /** process the responder's resp; returns the two transport cipher states. */
  finish: (respMsg: Uint8Array) => { sendCS: CipherState; recvCS: CipherState };
  /** zeroize the ephemeral handshake secrets (call on any non-success path). */
  cleanup: () => void;
}

/** the responder's completed hybrid handshake. */
export interface ResponderHandshake {
  /** the noise_resp message to send back (0x02). */
  message: Uint8Array;
  sendCS: CipherState;
  recvCS: CipherState;
  /** the initiator's static x25519 key, for peer authentication by the caller. */
  remoteXPub: Uint8Array;
}

// -- core Noise functions --

/** h = SHA-256(h || data) */
function mixHash(h: Uint8Array, data: Uint8Array): Uint8Array {
  return sha256(concat(h, data));
}

/** Noise HKDF - extract with ck as salt, expand into N 32-byte outputs */
function noiseHKDF(ck: Uint8Array, ikm: Uint8Array, outputs: 2): [Uint8Array, Uint8Array];
function noiseHKDF(
  ck: Uint8Array,
  ikm: Uint8Array,
  outputs: 3,
): [Uint8Array, Uint8Array, Uint8Array];
function noiseHKDF(ck: Uint8Array, ikm: Uint8Array, outputs: 2 | 3): Uint8Array[] {
  const prk = extract(sha256, ikm, ck);
  const okm = expand(sha256, prk, undefined, 32 * outputs);
  const result: Uint8Array[] = [];
  for (let i = 0; i < outputs; i++) {
    result.push(okm.slice(i * 32, (i + 1) * 32));
  }
  return result;
}

/** mixKey(ck, ikm) -> [new_ck, new_k], resets n to 0 */
function mixKey(ck: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  return noiseHKDF(ck, ikm, 2);
}

/** 12-byte LE nonce: 4 zero bytes + 8-byte LE counter (Noise spec convention) */
function nonceBytes(n: bigint): Uint8Array {
  const buf = new Uint8Array(12);
  const view = new DataView(buf.buffer);
  view.setUint32(4, Number(n & 0xffffffffn), true);
  view.setUint32(8, Number((n >> 32n) & 0xffffffffn), true);
  return buf;
}

function encryptWithAD(
  k: Uint8Array,
  n: bigint,
  ad: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  return chacha20poly1305(k, nonceBytes(n), ad).encrypt(plaintext);
}

function decryptWithAD(
  k: Uint8Array,
  n: bigint,
  ad: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  return chacha20poly1305(k, nonceBytes(n), ad).decrypt(ciphertext);
}

/** Encrypt plaintext, mix ciphertext into h. If k is null, pass plaintext in the clear. */
function encryptAndHash(
  k: Uint8Array | null,
  n: bigint,
  h: Uint8Array,
  plaintext: Uint8Array,
): { ct: Uint8Array; h: Uint8Array; n: bigint } {
  if (k === null) {
    return { ct: plaintext, h: mixHash(h, plaintext), n };
  }
  const ct = encryptWithAD(k, n, h, plaintext);
  return { ct, h: mixHash(h, ct), n: n + 1n };
}

/** Decrypt ciphertext, mix it into h. If k is null, treat ciphertext as plaintext. */
function decryptAndHash(
  k: Uint8Array | null,
  n: bigint,
  h: Uint8Array,
  ciphertext: Uint8Array,
): { pt: Uint8Array; h: Uint8Array; n: bigint } {
  if (k === null) {
    return { pt: ciphertext, h: mixHash(h, ciphertext), n };
  }
  const pt = decryptWithAD(k, n, h, ciphertext);
  return { pt, h: mixHash(h, ciphertext), n: n + 1n };
}

/** x25519 Diffie-Hellman */
function dh(priv: Uint8Array, pub: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(priv, pub);
}

// -- helpers --

function concat(...arrays: Uint8Array[]): Uint8Array {
  const len = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function zeroize(buf: Uint8Array): void {
  buf.fill(0);
}

// ---------------------------------------------------------------------------
// error taxonomy (what channel:auto may downgrade on)
// ---------------------------------------------------------------------------
//
// `channel: 'auto'` (channel-select.ts) falls back to the CLASSICAL channel
// ONLY on a genuine, well-formed CAPABILITY signal from the peer: an explicit
// refusal naming the protocol it speaks instead of ours (NOISE_REFUSE). Every
// other failure - a malformed or truncated frame, an AEAD or decapsulation
// failure, a peer-key mismatch, a relay/socket outage, the handshake deadline -
// is a TRANSPORT failure and PROPAGATES. So a hostile relay cannot force a
// post-quantum -> classical downgrade with one crafted frame, and an outage is
// never misread as "this peer is not post-quantum capable".
//
// Each class carries a stable `name` so a caller (and openChannel) can branch on
// it without importing the concrete type.

/** the peer cannot complete the hybrid handshake - a genuine capability signal. */
const NOISE_HANDSHAKE_ERROR = 'NoiseHandshakeError';
/** the peer's frame is not a valid hybrid message (wrong tag, short, tampered). */
const NOISE_MALFORMED_ERROR = 'NoiseMalformedMessageError';
/** a transport frame failed to decrypt (replayed, dropped, reordered, tampered). */
const NOISE_TRANSPORT_ERROR = 'NoiseTransportError';
/** the peer never completed the handshake inside the deadline. */
const NOISE_HANDSHAKE_TIMEOUT_ERROR = 'NoiseHandshakeTimeoutError';

/** tag `e` with a stable error `name` and return it (the message is preserved). */
const tagged = (name: string, e: unknown): Error => {
  const err = e instanceof Error ? e : new Error(String(e));
  err.name = name;
  return err;
};

/** tag `e` as a malformed peer message (NOT a downgrade signal). */
const asMalformedMessage = (e: unknown): Error => tagged(NOISE_MALFORMED_ERROR, e);

/** tag `e` as a transport failure (NOT a downgrade signal). */
const asTransportError = (e: unknown): Error => tagged(NOISE_TRANSPORT_ERROR, e);

/** run a handshake crypto step, tagging any throw as a malformed message. */
const malformedStep = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    throw asMalformedMessage(e);
  }
};

/**
 * True for a genuine handshake-CAPABILITY failure - a well-formed refusal from a
 * peer that cannot do the hybrid protocol - as opposed to a MALFORMED frame, a
 * TRANSPORT failure (relay down, socket error, deadline) or an outage.
 * `openChannel(..., 'auto')` uses this to decide whether a downgrade is
 * legitimate; nothing else is ever tagged as a handshake failure.
 */
export const isNoiseHandshakeFailure = (e: unknown): boolean =>
  e instanceof Error && e.name === NOISE_HANDSHAKE_ERROR;

/** True for a fatal post-handshake transport failure (replay/drop/tampered frame). */
export const isNoiseTransportError = (e: unknown): boolean =>
  e instanceof Error && e.name === NOISE_TRANSPORT_ERROR;

/** True for the handshake-deadline failure (the peer opened the socket but never answered). */
export const isNoiseHandshakeTimeoutError = (e: unknown): boolean =>
  e instanceof Error && e.name === NOISE_HANDSHAKE_TIMEOUT_ERROR;

// -- protocol refusal (the one downgrade-eligible capability signal) ---------
//
// A peer that receives a hybrid init but does not speak this protocol answers
// with a refusal naming the protocol it DOES speak. Only a well-formed refusal
// is a capability signal; malformed bytes are a transport error and propagate.
//
// HONEST SCOPE: this is the READ side plus the fixed wire format. No zafu
// responder emits a refusal yet - `./channel` parses JSON `keyex` only and drops
// a binary init, so against it a hybrid initiator sees the readiness deadline
// (`NoiseHandshakeTimeoutError`), which `'auto'` rethrows rather than
// downgrading on. `encodeProtocolRefusal` is exported so the classical channel
// can adopt the format without a second definition; until both ends do, a
// classical-only peer is reached with `channel: 'classical'`.

/**
 * Encode a protocol refusal: `[0x04][u16 BE name length][utf8 protocol name]`.
 * The wire format the hybrid initiator parses (`parseProtocolRefusal`), so a
 * responder that cannot do the hybrid handshake can name what it speaks and let
 * an `'auto'` initiator downgrade deliberately instead of guessing from an
 * opaque crypto error. Exported for that future responder; nothing sends it yet.
 */
export function encodeProtocolRefusal(protocol: string): Uint8Array {
  const name = new TextEncoder().encode(protocol);
  if (name.length === 0 || name.length > 0xffff) {
    throw new Error('noise: invalid protocol name length');
  }
  const out = new Uint8Array(3 + name.length);
  out[0] = NOISE_REFUSE;
  out[1] = (name.length >> 8) & 0xff;
  out[2] = name.length & 0xff;
  out.set(name, 3);
  return out;
}

/** Parse a refusal; throw a MALFORMED error (never a capability signal) on bad bytes. */
function parseProtocolRefusal(msg: Uint8Array): string {
  if (msg.length < 3 || msg[0] !== NOISE_REFUSE) {
    throw asMalformedMessage(new Error('noise: not a protocol refusal message'));
  }
  const nameLen = ((msg[1] ?? 0) << 8) | (msg[2] ?? 0);
  if (nameLen === 0 || msg.length !== 3 + nameLen) {
    throw asMalformedMessage(new Error('noise: malformed protocol refusal message'));
  }
  return new TextDecoder().decode(msg.slice(3));
}

/** constant-time equality for two byte arrays (peer-key authentication). */
export function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

function unhex(h: string): Uint8Array {
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < h.length; i += 2) {
    bytes[i / 2] = parseInt(h.slice(i, i + 2), 16);
  }
  return bytes;
}

// -- ed25519 to x25519 conversion --

function edPubToX(edPub: Uint8Array): Uint8Array {
  return ed25519.utils.toMontgomery(edPub);
}

function edPrivToX(edPriv: Uint8Array): Uint8Array {
  const seed = edPriv.length === 64 ? edPriv.slice(0, 32) : edPriv;
  return ed25519.utils.toMontgomerySecret(seed);
}

// -- Noise symmetric state initialization --

function initSymmetric(): { ck: Uint8Array; h: Uint8Array } {
  // protocol name is > 32 bytes, so hash it per Noise spec
  const h = sha256(new TextEncoder().encode(PROTOCOL_NAME));
  const ck = h.slice();
  return { ck, h };
}

/** split(ck) -> [k1, k2] two independent CipherState keys */
function split(ck: Uint8Array): [Uint8Array, Uint8Array] {
  return noiseHKDF(ck, EMPTY, 2);
}

// -- initiator handshake: -> e, es, s, ss --

export function initiatorHandshake(
  localXPriv: Uint8Array,
  localXPub: Uint8Array,
  remoteXPub: Uint8Array,
): InitiatorHandshake {
  let { ck, h } = initSymmetric();

  // pre-message: <- s (responder static known)
  h = mixHash(h, remoteXPub);

  // -> e: generate ephemeral x25519, mix pubkey into h
  const ePriv = x25519.utils.randomSecretKey();
  const ePub = x25519.getPublicKey(ePriv);
  h = mixHash(h, ePub);

  // -> e_pq: generate an EPHEMERAL ML-KEM-768 keypair and send its public
  // encapsulation key. Ephemeral (fresh per handshake, never stored) so the
  // ML-KEM secret it protects is forward-secret. Bind the ek into the transcript.
  const mlKem = mlkem768KeygenEphemeral();
  h = mixHash(h, mlKem.publicKey);

  // -> es: DH(e, rs)
  let k: Uint8Array;
  [ck, k] = mixKey(ck, dh(ePriv, remoteXPub));
  let n = 0n;

  // -> s: encrypt our static x25519 pubkey (32 bytes -> 48 bytes with tag)
  const encS = encryptAndHash(k, n, h, localXPub);
  h = encS.h;
  n = encS.n;

  // -> ss: DH(s, rs)
  [ck, k] = mixKey(ck, dh(localXPriv, remoteXPub));
  n = 0n;

  // encrypt empty payload.
  // NOTE: the init payload is necessarily CLASSICAL-only - no shared ML-KEM
  // secret exists yet at this point in the flow (the responder has not
  // encapsulated). The TRANSPORT keys are fully hybrid (the ML-KEM secret is
  // mixed in before split). If this init payload ever carries data, treat its
  // confidentiality as classical-only; put anything needing PQ into transport
  // messages after the handshake instead.
  const encPayload = encryptAndHash(k, n, h, EMPTY);
  h = encPayload.h;

  // wire: [0x01][ePub 32][mlkem_ek 1184][encrypted static 48][encrypted payload 16]
  const message = concat(
    new Uint8Array([NOISE_INIT]),
    ePub,
    mlKem.publicKey,
    encS.ct,
    encPayload.ct,
  );

  // save handshake state for processing the response
  const savedCk = ck.slice();
  const savedH = h.slice();
  const savedEPriv = ePriv.slice();
  const savedMlSk = mlKem.secretKey.slice();

  function finish(resp: Uint8Array): { sendCS: CipherState; recvCS: CipherState } {
    if (resp[0] !== NOISE_RESP) {
      throw asMalformedMessage(new Error('noise: expected resp message (0x02)'));
    }
    if (resp.length < NOISE_RESP_MIN_LEN) {
      throw asMalformedMessage(
        new Error(`noise: resp message too short (${resp.length} < ${NOISE_RESP_MIN_LEN})`),
      );
    }
    const re = resp.slice(1, 33);
    const mlCt = resp.slice(33, 33 + MLKEM_CT_LEN);
    const respCt = resp.slice(33 + MLKEM_CT_LEN);

    let rh = mixHash(savedH, re);
    // <- e_pq: bind the responder's ML-KEM ciphertext into the transcript
    rh = mixHash(rh, mlCt);
    let rck: Uint8Array = savedCk;

    // <- ee: DH(e, re)
    [rck] = mixKey(rck, dh(savedEPriv, re));

    // <- se: DH(s, re) - initiator static with responder ephemeral
    const [seRck, rk] = mixKey(rck, dh(localXPriv, re));
    rck = seRck;

    // decrypt responder payload (empty)
    const dec = malformedStep(() => decryptAndHash(rk, 0n, rh, respCt));
    rh = dec.h;

    // <- pq: decapsulate the ML-KEM secret and mix it in LAST, so the transport
    // keys depend on both the X25519 chain AND the ML-KEM secret. A passive
    // recorder must break BOTH to derive them.
    const mlSs = malformedStep(() => mlkem768Decapsulate(mlCt, savedMlSk));
    [rck] = mixKey(rck, mlSs);
    zeroize(mlSs);

    // split into transport cipher states
    const [k1, k2] = split(rck);

    // zeroize handshake secrets. finish() is the success path (cleanup() only
    // runs on error), so zeroize the ORIGINAL ephemeral secrets here too - not
    // just their saved copies - or the initiator's ephemeral x25519 and ML-KEM
    // decapsulation keys would linger in memory after a successful handshake.
    zeroize(ePriv);
    zeroize(mlKem.secretKey);
    zeroize(savedCk);
    zeroize(savedH);
    zeroize(savedEPriv);
    zeroize(savedMlSk);

    return {
      sendCS: { k: k1, n: 0n },
      recvCS: { k: k2, n: 0n },
    };
  }

  function cleanup(): void {
    zeroize(ePriv);
    zeroize(mlKem.secretKey);
    zeroize(savedCk);
    zeroize(savedEPriv);
    zeroize(savedH);
    zeroize(savedMlSk);
  }

  return { message, finish, cleanup };
}

// -- responder handshake: <- e, ee, se --

export function responderHandshake(
  localXPriv: Uint8Array,
  localXPub: Uint8Array,
  initMsg: Uint8Array,
): ResponderHandshake {
  if (initMsg[0] !== NOISE_INIT) {
    throw asMalformedMessage(new Error('noise: expected init message (0x01)'));
  }
  if (initMsg.length < NOISE_INIT_MIN_LEN) {
    throw asMalformedMessage(
      new Error(`noise: init message too short (${initMsg.length} < ${NOISE_INIT_MIN_LEN})`),
    );
  }

  let { ck, h } = initSymmetric();

  // pre-message: <- s (our static known to initiator)
  h = mixHash(h, localXPub);

  // -> e: read initiator ephemeral
  const re = initMsg.slice(1, 33);
  h = mixHash(h, re);

  // -> e_pq: read the initiator's ephemeral ML-KEM encapsulation key
  const mlEk = initMsg.slice(33, 33 + MLKEM_EK_LEN);
  h = mixHash(h, mlEk);

  const staticOff = 33 + MLKEM_EK_LEN;

  // -> es: DH(s, re) - responder static with initiator ephemeral
  let k: Uint8Array;
  [ck, k] = mixKey(ck, dh(localXPriv, re));
  let n = 0n;

  // -> s: decrypt initiator's static x25519 pubkey
  const encStatic = initMsg.slice(staticOff, staticOff + 32 + TAG_LEN);
  const decS = malformedStep(() => decryptAndHash(k, n, h, encStatic));
  h = decS.h;
  n = decS.n;
  const remoteXPub = decS.pt;

  // -> ss: DH(s, rs) - responder static with initiator static
  [ck, k] = mixKey(ck, dh(localXPriv, remoteXPub));
  n = 0n;

  // decrypt initiator payload (empty)
  const encPayload = initMsg.slice(staticOff + 32 + TAG_LEN);
  const decPayload = malformedStep(() => decryptAndHash(k, n, h, encPayload));
  h = decPayload.h;

  // <- e: generate responder ephemeral
  const ePriv = x25519.utils.randomSecretKey();
  const ePub = x25519.getPublicKey(ePriv);
  h = mixHash(h, ePub);

  // <- e_pq: encapsulate against the initiator's ML-KEM ek. mlSs is forward-secret
  // (initiator ek is ephemeral); bind the ciphertext into the transcript.
  const { sharedSecret: mlSs, cipherText: mlCt } = malformedStep(() => mlkem768Encapsulate(mlEk));
  h = mixHash(h, mlCt);

  // <- ee: DH(e, re)
  [ck] = mixKey(ck, dh(ePriv, re));

  // <- se: DH(e, rs) - responder ephemeral with initiator static
  [ck, k] = mixKey(ck, dh(ePriv, remoteXPub));
  n = 0n;

  // encrypt empty response payload
  const respEnc = encryptAndHash(k, n, h, EMPTY);

  // <- pq: mix the ML-KEM secret in LAST, so transport keys depend on both the
  // X25519 chain and the ML-KEM secret (must break both to recover them).
  [ck] = mixKey(ck, mlSs);
  zeroize(mlSs);

  // wire: [0x02][ePub 32][mlkem_ct 1088][encrypted payload]
  const message = concat(new Uint8Array([NOISE_RESP]), ePub, mlCt, respEnc.ct);

  // split - responder send = initiator recv and vice versa
  const [initSend, initRecv] = split(ck);

  // zeroize handshake secrets
  zeroize(ePriv);
  zeroize(ck);

  return {
    message,
    sendCS: { k: initRecv, n: 0n },
    recvCS: { k: initSend, n: 0n },
    remoteXPub,
  };
}

// -- transport encryption (0x03 prefix) --

/**
 * Symmetric-key ratchet interval (P3 Layer 1). Every REKEY_EVERY messages on a
 * cipherstate we advance its key by a ONE-WAY KDF, so a key compromise cannot
 * decrypt traffic from before the last ratchet boundary (forward secrecy for the
 * live channel, which the single hybrid handshake did not provide post-setup).
 *
 * This is deterministic and counter-driven: both directions cross the same
 * boundary at the same counter and derive the same next key, so NO extra wire
 * bytes and no coordination are needed. It does NOT provide post-compromise
 * security - that needs a fresh ML-KEM re-encapsulation mixed in (P3 Layer 2),
 * an interactive sub-protocol left as follow-up.
 */
export const REKEY_EVERY = 256n;

/** k' = HKDF(salt=k, ikm=empty); old k is unrecoverable from k' (one-way). */
function ratchetKey(k: Uint8Array): Uint8Array {
  const [next] = noiseHKDF(k, EMPTY, 2);
  return next;
}

/** Advance the key at a ratchet boundary (n a positive multiple of REKEY_EVERY). */
function maybeRatchet(cs: CipherState): void {
  if (cs.n > 0n && cs.n % REKEY_EVERY === 0n) {
    const next = ratchetKey(cs.k);
    zeroize(cs.k);
    cs.k = next;
  }
}

export function encryptTransport(cs: CipherState, plaintext: Uint8Array): Uint8Array {
  // ratchet BEFORE using the key for message n, so both ends agree on the key
  // for this counter. n stays monotonic (the wire counter is unambiguous); a
  // fresh key with an already-advanced nonce is still unique.
  maybeRatchet(cs);
  const ct = chacha20poly1305(cs.k, nonceBytes(cs.n)).encrypt(plaintext);
  // wire: [0x03][8-byte BE counter][ciphertext + tag]
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, cs.n, false);
  cs.n += 1n;
  return concat(new Uint8Array([NOISE_TRANSPORT]), counter, ct);
}

export function decryptTransport(cs: CipherState, msg: Uint8Array): Uint8Array {
  if (msg.length < 9 || msg[0] !== NOISE_TRANSPORT) {
    throw asTransportError(new Error('noise: expected transport message (0x03)'));
  }
  const wireN = new DataView(msg.buffer, msg.byteOffset + 1, 8).getBigUint64(0, false);
  // The nonce is IMPLICIT and the key ratchets with the counter, so an out-of-
  // order, dropped, replayed or forged counter can never be resynced. This is
  // channel-fatal (the caller closes and zeroizes); it must never be swallowed,
  // or the direction would wedge silently while the channel claims to be up.
  if (wireN !== cs.n) {
    throw asTransportError(new Error(`noise: counter mismatch (expected ${cs.n}, got ${wireN})`));
  }
  // mirror the sender: ratchet at the same boundary before decrypting message n.
  maybeRatchet(cs);
  const ct = msg.slice(9);
  let pt: Uint8Array;
  try {
    pt = chacha20poly1305(cs.k, nonceBytes(cs.n)).decrypt(ct);
  } catch (e) {
    throw asTransportError(e);
  }
  cs.n += 1n;
  return pt;
}

// -- public API --

/**
 * Deadline for the hybrid handshake. A peer (or relay) that opens the socket and
 * then never answers must not leave the caller's promise pending forever; on
 * expiry the socket is closed and the channel rejects with a tagged
 * NoiseHandshakeTimeoutError (a transport failure - channel:auto never downgrades on it).
 */
export const HANDSHAKE_TIMEOUT_MS = 15_000;

/** Create a Noise IK encrypted channel to a peer via relay WebSocket. */
export async function createNoiseChannel(
  session: SessionKey,
  peerPubkey: string,
  relayUrl?: string,
): Promise<ZidChannel> {
  const localXPub = edPubToX(unhex(session.pubkey));
  const localXPriv = edPrivToX(session.privkey);
  const remoteXPub = edPubToX(unhex(peerPubkey));

  const handlers: ((data: Uint8Array) => void)[] = [];
  const errorHandlers: ((e: Error) => void)[] = [];
  let sendCS: CipherState | null = null;
  let recvCS: CipherState | null = null;
  let ws: WebSocket | null = null;

  // initiator = lexicographically smaller pubkey
  const isInitiator = session.pubkey < peerPubkey;

  const url =
    relayUrl || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/zid`;

  const handshakeComplete = new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // the initiator's in-flight handshake, so the deadline can zeroize its secrets.
    let pending: InitiatorHandshake | null = null;

    const clearTimer = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const settle = (error?: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer();
      if (error === undefined) {
        resolve();
      } else {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    /**
     * A transport frame could not be decrypted (replayed, dropped, reordered or
     * tampered). The implicit nonce can never resync, so this is channel-FATAL:
     * close, zeroize, and hand the typed error (isNoiseTransportError) to the
     * caller. NEVER swallow it - a swallowed mismatch wedges the direction for
     * good while the channel still reports itself established.
     */
    const fatalTransport = (e: unknown): void => {
      const err = e instanceof Error ? e : new Error(String(e));
      if (sendCS) {
        zeroize(sendCS.k);
        sendCS = null;
      }
      if (recvCS) {
        zeroize(recvCS.k);
        recvCS = null;
      }
      ws?.close();
      ws = null;
      for (const h of errorHandlers) {
        h(err);
      }
    };

    function transportHandler(ev: MessageEvent): void {
      if (typeof ev.data === 'string' || !recvCS) {
        return;
      }
      const data = new Uint8Array(ev.data as ArrayBuffer);
      if (data[0] !== NOISE_TRANSPORT) {
        return;
      }
      let pt: Uint8Array;
      try {
        pt = decryptTransport(recvCS, data);
      } catch (e) {
        fatalTransport(e);
        return;
      }
      for (const h of handlers) {
        h(pt);
      }
    }

    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      // announce to relay so it knows our routing pair
      ws?.send(JSON.stringify({ type: 'announce', from: session.pubkey, to: peerPubkey }));

      if (isInitiator) {
        pending = initiatorHandshake(localXPriv, localXPub, remoteXPub);
        ws?.send(pending.message);

        ws!.onmessage = ev => {
          if (typeof ev.data === 'string') {
            return;
          }
          try {
            const data = new Uint8Array(ev.data as ArrayBuffer);
            // A well-formed refusal is the ONLY downgrade-eligible signal: the
            // peer names the protocol it speaks instead of ours. Malformed bytes
            // fall through to a crypto error and propagate as MALFORMED.
            if (data[0] === NOISE_REFUSE) {
              const offered = parseProtocolRefusal(data);
              pending?.cleanup();
              ws?.close();
              settle(
                tagged(
                  NOISE_HANDSHAKE_ERROR,
                  new Error(`noise: peer does not support ${PROTOCOL_NAME}; it offered ${offered}`),
                ),
              );
              return;
            }
            if (data[0] === NOISE_RESP) {
              const result = pending!.finish(data);
              sendCS = result.sendCS;
              recvCS = result.recvCS;
              ws!.onmessage = transportHandler;
              zeroize(localXPriv);
              settle();
            }
          } catch (e) {
            pending?.cleanup();
            ws?.close();
            settle(e);
          }
        };
      }
    };

    // responder path - listen for init before we get promoted to initiator handler
    ws.onmessage = ev => {
      if (typeof ev.data === 'string') {
        return;
      }
      const data = new Uint8Array(ev.data as ArrayBuffer);
      if (data[0] === NOISE_INIT && !isInitiator) {
        try {
          const result = responderHandshake(localXPriv, localXPub, data);
          // AUTHENTICATE THE PEER: the responder must verify the initiator's
          // static key is the peer we expect. Without this, an active party on
          // the untrusted relay can send a well-formed init and complete a fully
          // encrypted, "authenticated" channel with their OWN key while we
          // believe .peer is peerPubkey - impersonation. Reject + zeroize on
          // mismatch (constant-time compare). This is an ATTACK, not a capability
          // signal, so it is tagged MALFORMED and never triggers a downgrade.
          if (!ctEqual(result.remoteXPub, remoteXPub)) {
            zeroize(result.sendCS.k);
            zeroize(result.recvCS.k);
            zeroize(localXPriv);
            throw asMalformedMessage(new Error('noise: unexpected initiator (peer key mismatch)'));
          }
          sendCS = result.sendCS;
          recvCS = result.recvCS;
          ws?.send(result.message);
          ws!.onmessage = transportHandler;
          zeroize(localXPriv);
          settle();
        } catch (e) {
          ws?.close();
          settle(e);
        }
      }
    };

    ws.onerror = () => settle(new Error('noise: WebSocket error'));
    ws.onclose = () => {
      if (!sendCS) {
        settle(new Error('noise: connection closed during handshake'));
      }
    };

    // Bounded handshake deadline: a relay that opens the socket and never
    // answers must not leave openChannel's promise pending forever. Closes the
    // socket and rejects with the tagged NoiseHandshakeTimeoutError - a TRANSPORT
    // failure, so channel:auto PROPAGATES it rather than downgrading.
    timer = setTimeout(() => {
      pending?.cleanup();
      ws?.close();
      settle(
        tagged(
          NOISE_HANDSHAKE_TIMEOUT_ERROR,
          new Error(`noise: hybrid handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms`),
        ),
      );
    }, HANDSHAKE_TIMEOUT_MS);
  });

  try {
    await handshakeComplete;
  } catch (e) {
    // any handshake failure path (bad resp, peer mismatch, ws error/close):
    // zeroize the converted static private key that success would have wiped.
    zeroize(localXPriv);
    throw e;
  }

  return {
    peer: peerPubkey,

    send(data: string | Uint8Array): void {
      if (!sendCS || !ws) {
        return;
      }
      const plain = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      ws.send(encryptTransport(sendCS, plain));
    },

    // 'message' delivers decrypted payloads. 'error' delivers a typed fatal
    // transport error (see isNoiseTransportError) AFTER the channel has closed
    // and zeroized its keys - so a caller can act on a wedged direction
    // (reconnect, surface it) instead of watching a silently dead channel.
    on(
      event: 'message' | 'error',
      handler: ((data: Uint8Array) => void) | ((e: Error) => void),
    ): void {
      if (event === 'message') {
        handlers.push(handler as (data: Uint8Array) => void);
      } else {
        errorHandlers.push(handler as (e: Error) => void);
      }
    },

    close(): void {
      if (sendCS) {
        zeroize(sendCS.k);
        sendCS = null;
      }
      if (recvCS) {
        zeroize(recvCS.k);
        recvCS = null;
      }
      ws?.close();
      ws = null;
    },
  };
}
