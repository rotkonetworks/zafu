/**
 * Group sessions - the coordination shape.
 *
 * Built for ceremonies rather than chat: FROST DKG and signing are multi-party
 * protocols where every participant broadcasts one message per round, and a
 * single lost message stalls everything. So this is deliberately the smallest
 * thing that can carry a round: fan-out over the pairwise hybrid channels the SDK
 * already has (one copy per member), plus an envelope that adds exactly what a
 * ceremony needs on top of transport encryption -
 *
 *     envelope   { group, round, from, payload, sig }
 *     signed     'zid-group-v1' || u32be(round) || lp(group) || lp(from) || sha256(payload)
 *     accepted   from ∈ roster ∧ signature verifies ∧ (round, from) unseen
 *
 * Payload confidentiality is the TRANSPORT's job: each copy rides that member's
 * pairwise encrypted channel, so the relay learns nothing about the group and
 * this module never invents its own crypto. What it adds is attribution (a
 * signature over the round, group and payload), replay rejection, and honest
 * progress reporting - `awaitRound` resolves when the round is complete and
 * otherwise names who is missing, because "the ceremony hung" is not a useful
 * error.
 *
 * Limits, stated up front: no forward secrecy beyond the pairwise channel's (a
 * ceremony is seconds long, but this is not a chat protocol); fan-out cost grows
 * with the roster, so ~8-10 members is where another shape is needed; and the
 * roster is agreed out of band, which for a multisig config is exactly the case.
 * See the design note for the shared-secret mailbox that a larger or social group
 * would need - and for why it needs a ratchet and rotation, which this does not.
 */

import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** domain separator: bytes signed for one group are never valid for anything else. */
const DOMAIN = enc.encode('zid-group-v1');

/** one envelope: who spoke, in which round, of which group, with what. */
export interface GroupEnvelope {
  group: string;
  round: number;
  /** sender's roster pubkey (hex) */
  from: string;
  payload: Uint8Array;
  /** hex signature over the bytes above (see `signedBytes`) */
  sig: string;
}

/** the signing half of an identity - `ZidIdentity` satisfies this. */
export interface GroupMember {
  pubkey: string;
  sign(bytes: Uint8Array): Promise<string>;
  verify(bytes: Uint8Array, sig: string, pubkey: string): Promise<boolean>;
}

export interface GroupSessionOptions {
  /** the ceremony id; agreed out of band with the roster (e.g. the multisig config). */
  id: string;
  me: GroupMember;
  /** every participant, INCLUDING me, as hex pubkeys. */
  members: readonly string[];
  /** transport: hand these bytes to `to` over that member's pairwise channel. */
  deliver(to: string, bytes: Uint8Array): void | Promise<void>;
  /** inbound pairwise channel: call the handler with (peerPubkey, bytes). */
  subscribe(handler: (from: string, bytes: Uint8Array) => void): () => void;
}

export interface RoundStatus {
  round: number;
  /** who this session has accepted a message from in this round */
  received: string[];
  /** roster members still missing (never includes me) */
  missing: string[];
}

export interface GroupSession {
  readonly id: string;
  readonly members: readonly string[];
  /** send one message to the whole roster; resolves when every copy is handed over. */
  send(payload: Uint8Array, round: number): Promise<void>;
  /** observe accepted envelopes as they arrive. */
  onMessage(handler: (envelope: GroupEnvelope) => void): () => void;
  /**
   * Wait for a round to complete. `expect` defaults to the whole roster minus me.
   * Rejects on timeout with the missing members named.
   */
  awaitRound(
    round: number,
    opts?: { expect?: number; timeoutMs?: number },
  ): Promise<GroupEnvelope[]>;
  received(round: number): readonly GroupEnvelope[];
  status(round: number): RoundStatus;
  close(): void;
}

const u32be = (n: number): Uint8Array => {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new Error(`group: ${n} does not fit a u32`);
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
};

/** length-prefixed field: no two parts can be confused for different fields. */
const lp = (bytes: Uint8Array): Uint8Array => {
  const out = new Uint8Array(4 + bytes.length);
  out.set(u32be(bytes.length), 0);
  out.set(bytes, 4);
  return out;
};

const concat = (parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** exactly the bytes a member signs - exported so a test (or an implementation in another language) can recompute them. */
export const signedBytes = (
  group: string,
  round: number,
  from: string,
  payload: Uint8Array,
): Uint8Array =>
  concat([DOMAIN, u32be(round), lp(enc.encode(group)), lp(enc.encode(from)), sha256(payload)]);

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/** wire form: JSON, so a relay or another language can carry it without knowing anything about it. */
export const encodeGroupEnvelope = (envelope: GroupEnvelope): Uint8Array =>
  enc.encode(
    JSON.stringify({
      group: envelope.group,
      round: envelope.round,
      from: envelope.from,
      payload: b64(envelope.payload),
      sig: envelope.sig,
    }),
  );

/** what the wire carries - shape checked once, then consumed as a typed value. */
interface EnvelopeWire {
  group: string;
  round: number;
  from: string;
  payload: string;
  sig: string;
}

/** `in` narrowing rather than a cast: this is untrusted input off a socket. */
const isEnvelopeWire = (value: unknown): value is EnvelopeWire => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('group' in value) || typeof value.group !== 'string') {
    return false;
  }
  if (!('round' in value) || typeof value.round !== 'number') {
    return false;
  }
  if (!('from' in value) || typeof value.from !== 'string') {
    return false;
  }
  if (!('payload' in value) || typeof value.payload !== 'string') {
    return false;
  }
  if (!('sig' in value) || typeof value.sig !== 'string') {
    return false;
  }
  return true;
};

/** tolerant: anything malformed is `null`, never a throw into a socket handler. */
export const decodeGroupEnvelope = (bytes: Uint8Array): GroupEnvelope | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(dec.decode(bytes));
  } catch {
    return null;
  }
  if (!isEnvelopeWire(parsed)) {
    return null;
  }
  try {
    return {
      group: parsed.group,
      round: parsed.round,
      from: parsed.from,
      payload: unb64(parsed.payload),
      sig: parsed.sig,
    };
  } catch {
    return null; // payload was not base64
  }
};

/**
 * A round-structured session over a pairwise transport.
 *
 * `members` is the authenticated roster: a message from anyone else is dropped
 * before it can reach a handler, and every accepted message carries a signature
 * that a member can re-verify later (a transcript is evidence, not hearsay).
 */
export function createGroupSession(opts: GroupSessionOptions): GroupSession {
  const roster = opts.members.map(m => m.toLowerCase());
  const me = opts.me.pubkey.toLowerCase();
  if (!roster.includes(me)) {
    throw new Error('group: this session is not a member of its own roster');
  }
  if (new Set(roster).size !== roster.length) {
    throw new Error('group: roster has duplicate members');
  }
  const peers = roster.filter(p => p !== me);

  /** accepted envelopes per round, keyed `round|sender` so a replay is a no-op. */
  const accepted = new Map<string, GroupEnvelope>();
  const handlers = new Set<(envelope: GroupEnvelope) => void>();
  const waiters = new Set<{
    round: number;
    expect: number;
    resolve: (e: GroupEnvelope[]) => void;
  }>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let closed = false;

  const receivedFor = (round: number): GroupEnvelope[] =>
    [...accepted.values()].filter(e => e.round === round);

  const notifyWaiters = (): void => {
    for (const waiter of [...waiters]) {
      const have = receivedFor(waiter.round);
      if (have.length >= waiter.expect) {
        waiters.delete(waiter);
        waiter.resolve(have);
      }
    }
  };

  const accept = async (peer: string, bytes: Uint8Array): Promise<void> => {
    if (closed) {
      return;
    }
    const from = peer.toLowerCase();
    if (from === me || !roster.includes(from)) {
      return; // not a member: dropped before any handler sees it
    }
    const envelope = decodeGroupEnvelope(bytes);
    if (envelope?.group !== opts.id || envelope.from.toLowerCase() !== from) {
      return; // malformed, another group, or a claimed sender that is not the channel's peer
    }
    const key = `${envelope.round}|${from}`;
    if (accepted.has(key)) {
      return; // replay: a round has exactly one message per member
    }
    const ok = await opts.me
      .verify(signedBytes(opts.id, envelope.round, from, envelope.payload), envelope.sig, from)
      .catch(() => false);
    if (!ok) {
      return; // forged, or tampered in transit
    }
    accepted.set(key, { ...envelope, from });
    for (const handler of handlers) {
      handler({ ...envelope, from });
    }
    notifyWaiters();
  };

  const unsubscribe = opts.subscribe((from, bytes) => {
    void accept(from, bytes);
  });

  return {
    id: opts.id,
    members: roster,

    async send(payload: Uint8Array, round: number): Promise<void> {
      if (closed) {
        throw new Error('group: session is closed');
      }
      const sig = await opts.me.sign(signedBytes(opts.id, round, me, payload));
      const wire = encodeGroupEnvelope({ group: opts.id, round, from: me, payload, sig });
      // fan-out: one copy per peer, over that peer's own pairwise channel. A
      // failure propagates, because a ceremony that silently skips a recipient
      // hangs five rounds later instead of reporting now.
      await Promise.all(peers.map(async to => opts.deliver(to, wire)));
    },

    onMessage(handler: (envelope: GroupEnvelope) => void): () => void {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },

    awaitRound(round: number, o = {}): Promise<GroupEnvelope[]> {
      const expect = o.expect ?? peers.length;
      const already = receivedFor(round);
      if (already.length >= expect) {
        return Promise.resolve(already);
      }
      return new Promise<GroupEnvelope[]>((resolve, reject) => {
        const waiter = { round, expect, resolve };
        waiters.add(waiter);
        const timeoutMs = o.timeoutMs ?? 30_000;
        const timer = setTimeout(() => {
          timers.delete(timer);
          waiters.delete(waiter);
          const status = {
            round,
            received: receivedFor(round).map(e => e.from),
            missing: [] as string[],
          };
          status.missing = peers.filter(p => !status.received.includes(p));
          reject(
            new Error(
              `group: round ${round} incomplete (have ${status.received.length}/${expect}; missing ${status.missing.join(', ') || 'nobody'})`,
            ),
          );
        }, timeoutMs);
        timers.add(timer);
      });
    },

    received(round: number): readonly GroupEnvelope[] {
      return receivedFor(round);
    },

    status(round: number): RoundStatus {
      const received = receivedFor(round).map(e => e.from);
      return { round, received, missing: peers.filter(p => !received.includes(p)) };
    },

    close(): void {
      closed = true;
      unsubscribe();
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
      waiters.clear();
      handlers.clear();
    },
  };
}

/** hex helper re-exported so callers building a roster from identity keys need no second import. */
export const pubkeyHex = (bytes: Uint8Array): string => bytesToHex(bytes);
export const pubkeyBytes = (hex: string): Uint8Array => hexToBytes(hex);
