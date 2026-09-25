/**
 * Handing a room invite to exactly one peer.
 *
 * An invite is deliberately a bearer token: whoever holds it can read and
 * write the room. That is the whole membership model, and it means the one
 * dangerous moment in a room's life is the moment the invite travels — over
 * a signalling socket, a lobby server, a game's own transport. Those are
 * operated by somebody, and an invite in the clear is a room key in their log.
 *
 * So don't send it in the clear. `sealInvite` puts it in a zid sealed box
 * addressed to one recipient: post-quantum (X-Wing) whenever they advertise a
 * `pq_pubkey`, classical otherwise, and the call site does not change with
 * the backend. What travels is a ciphertext the carrier cannot open, which
 * means the transport does not have to be trusted to carry the key to a room
 * it must never read.
 *
 * The post-quantum path is the point for a chat room specifically. A room's
 * records sit on a relay for as long as its retention allows, and anyone may
 * copy them; X-Wing is what stops an invite recorded today from opening those
 * records once a quantum computer exists. Per zid, ML-KEM adds confidentiality
 * only — authentication is still X25519/ed25519, so this protects what was
 * said, not who said it.
 *
 * What this does NOT do: make the invite less of a bearer token. The
 * recipient can pass it on, and the room cannot tell. Sealing narrows who
 * learns it in transit, not what they may do with it afterwards.
 */

import { encodeInvite, parseInvite, type RoomInvite } from './room';

/**
 * A sealed invite, in a shape that survives JSON.
 *
 * zid's own sealed box carries `Uint8Array`s, which do not round-trip through
 * `JSON.stringify`. Most transports that would carry an invite are JSON, so
 * this is the form to put on the wire.
 */
export interface SealedInvite {
  /** hex. */
  readonly ciphertext: string;
  /** hex. */
  readonly ephemeralPubkey: string;
  /** whether the post-quantum path was actually taken, not merely intended. */
  readonly postQuantum: boolean;
  /** the epoch the recipient's pq key was advertised at, on the PQ path. */
  readonly pqEpoch?: number;
}

/** The half of a zid identity this module needs: sealing to, and opening for. */
export interface SealingIdentity {
  sealFor?: (
    recipient: unknown,
    bytes: Uint8Array,
  ) => Promise<{
    ciphertext: Uint8Array;
    ephemeral_pubkey: Uint8Array;
    postQuantum: boolean;
    pq_epoch?: number;
  }>;
  openSealed?: (sealed: {
    ciphertext: Uint8Array;
    ephemeral_pubkey: Uint8Array;
    pq_epoch?: number;
  }) => Promise<Uint8Array>;
}

const hex = (b: Uint8Array): string => [...b].map(x => x.toString(16).padStart(2, '0')).join('');

const unhex = (s: string): Uint8Array => {
  if (s.length % 2 !== 0 || /[^0-9a-f]/i.test(s)) {
    throw new Error('not hex');
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

/**
 * Seal `invite` to `recipient`.
 *
 * `recipient` is their advertised keys (or a bare ed25519 pubkey, which takes
 * the classical path because there is no pq key to use). Check
 * `postQuantum` on the result if you care which path was taken — the caller
 * decides whether a classical seal is good enough, because only the caller
 * knows what the room is for.
 *
 * @throws if this identity cannot seal, rather than falling back to plaintext.
 */
export const sealInvite = async (
  me: SealingIdentity,
  recipient: unknown,
  invite: RoomInvite,
): Promise<SealedInvite> => {
  if (!me.sealFor) {
    throw new Error('this identity cannot seal: no sealFor');
  }
  const box = await me.sealFor(recipient, new TextEncoder().encode(encodeInvite(invite)));
  return {
    ciphertext: hex(box.ciphertext),
    ephemeralPubkey: hex(box.ephemeral_pubkey),
    postQuantum: box.postQuantum,
    ...(box.pq_epoch === undefined ? {} : { pqEpoch: box.pq_epoch }),
  };
};

/**
 * Open an invite addressed to this identity.
 *
 * Anything that does not decrypt, or does not decrypt to a well-formed
 * invite, throws — a half-understood invite would otherwise become a room
 * nobody else is in.
 */
export const openInvite = async (
  me: SealingIdentity,
  sealed: SealedInvite,
): Promise<RoomInvite> => {
  if (!me.openSealed) {
    throw new Error('this identity cannot open: no openSealed');
  }
  const bytes = await me.openSealed({
    ciphertext: unhex(sealed.ciphertext),
    ephemeral_pubkey: unhex(sealed.ephemeralPubkey),
    ...(sealed.pqEpoch === undefined ? {} : { pq_epoch: sealed.pqEpoch }),
  });
  return parseInvite(new TextDecoder().decode(bytes));
};
