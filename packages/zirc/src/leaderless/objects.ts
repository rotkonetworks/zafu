/**
 * The objects members of a leaderless group agree on (zafu #110), and their
 * canonical bytes. Agreement is by content, never by position: everything two
 * members must agree on is one of these, addressed by the hash of its bytes,
 * and binds only with the signatures its rule names (see ./state).
 *
 * Encoding, so a second implementation (zcli `zirc-proto`) reproduces it byte
 * for byte:
 *
 *   lp(x)        u32 big-endian length of x, then x
 *   frame(D, f)  lp(utf8 D) ‖ lp(f1) ‖ lp(f2) ‖ ...
 *   list(xs)     lp(x1) ‖ lp(x2) ‖ ...   (itself one field, so framed again)
 *   id           sha256(frame(domain, fields)), 32 bytes, hex on the wire
 *   u8 / u32     fixed-width big-endian
 *   keys         raw 32-byte ed25519 public keys; hashes raw 32 bytes
 *   text         utf8
 *
 * A signature is ed25519 over `frame("zafu-sig-v1", [id])`: the id already
 * carries its object's domain, so one signing domain serves every object.
 * The vectors in `vectors/leaderless-v1.json` pin all of it.
 */

import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

export const DOMAIN = {
  genesis: 'zafu-g-v1',
  invite: 'zafu-i-v1',
  join: 'zafu-join-v1',
  pake: 'zafu-pake-v1',
  roster: 'zafu-r-v1',
  room: 'zafu-room-v1',
  rotate: 'zafu-rotate-v1',
  rotateBox: 'zafu-rotate-box-v1',
  sig: 'zafu-sig-v1',
  commit: 'zafu-dkg-c-v1',
  r1: 'zafu-r1-v1',
  h1: 'zafu-h1-v1',
  r2: 'zafu-r2-v1',
  reveal: 'zafu-dkg-s-v1',
  sk: 'zafu-fvk-v1',
  fvk: 'zafu-fvk-hash-v1',
} as const;

/** what a group is for; fixed at creation */
export const PURPOSE = { chat: 1, wallet: 2 } as const;
export type Purpose = keyof typeof PURPOSE;

/** `G`: fixed at creation, never edited. A chat says t = n = 0; changing t or n is a new G. */
export interface Genesis {
  purpose: Purpose;
  t: number;
  n: number;
  /** 16 bytes, hex: also the tag members derive their room keys from */
  salt: string;
  creator: string;
}

/** `I`: one invite, answered only by its owner */
export interface Invite {
  G: string;
  owner: string;
  /** the code's number, the door's nameplate */
  plate: number;
  /** the door's salt, 16 bytes hex */
  salt: string;
  /** unix seconds */
  expiry: number;
}

/** `join`: spends `I`, signed by its owner and the joiner */
export interface Join {
  I: string;
  joiner: string;
  /** the PAKE run that let them in, see {@link pakeHash} */
  th: string;
}

/** `R`: who is in, binding only with every member's signature */
export interface Roster {
  G: string;
  /** sorted ascending, no repeats */
  members: string[];
}

/** `rotate`: the room moves to a new secret that only `R`'s members hold */
export interface Rotate {
  R: string;
  /** room ids, see {@link roomId} */
  from: string;
  to: string;
}

const enc = new TextEncoder();

const HEX = /^(?:[0-9a-f]{2})*$/;
const bytesOf = (hex: string, len?: number): Uint8Array => {
  if (!HEX.test(hex) || (len !== undefined && hex.length !== len * 2)) {
    throw new Error(`not ${len ?? 'some'} bytes of hex`);
  }
  return hexToBytes(hex);
};
const key = (h: string) => bytesOf(h, 32);
const u8 = (n: number) => Uint8Array.of(n);
const u32 = (n: number) => {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) {
    throw new Error('not a u32');
  }
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};

const lp = (x: Uint8Array): Uint8Array => {
  const out = new Uint8Array(4 + x.length);
  new DataView(out.buffer).setUint32(0, x.length);
  out.set(x, 4);
  return out;
};
const cat = (xs: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0));
  xs.reduce((at, x) => (out.set(x, at), at + x.length), 0);
  return out;
};

export const list = (xs: Uint8Array[]): Uint8Array => cat(xs.map(lp));
export const frame = (domain: string, fields: Uint8Array[]): Uint8Array =>
  cat([lp(enc.encode(domain)), ...fields.map(lp)]);
const hash = (domain: string, fields: Uint8Array[]) => bytesToHex(sha256(frame(domain, fields)));

// -- the objects -------------------------------------------------------------

export const genesisBytes = (g: Genesis): Uint8Array => {
  const chat = g.purpose === 'chat';
  if (
    !(g.purpose in PURPOSE) ||
    (chat ? g.t !== 0 || g.n !== 0 : !(g.t >= 2 && g.t <= g.n && g.n <= 32))
  ) {
    throw new Error('not a genesis');
  }
  return frame(DOMAIN.genesis, [
    u8(PURPOSE[g.purpose]),
    u32(g.t),
    u32(g.n),
    bytesOf(g.salt, 16),
    key(g.creator),
  ]);
};

export const inviteBytes = (i: Invite): Uint8Array =>
  frame(DOMAIN.invite, [key(i.G), key(i.owner), u32(i.plate), bytesOf(i.salt, 16), u32(i.expiry)]);

export const joinBytes = (j: Join): Uint8Array =>
  frame(DOMAIN.join, [key(j.I), key(j.joiner), key(j.th)]);

/** a roster's members in their one canonical order */
export const sortKeys = (ks: string[]): string[] => [...new Set(ks)].sort();

export const rosterBytes = (r: Roster): Uint8Array => {
  if (r.members.join() !== sortKeys(r.members).join() || r.members.length < 1) {
    throw new Error('a roster is sorted, with no repeats');
  }
  return frame(DOMAIN.roster, [key(r.G), list(r.members.map(key))]);
};

export const rotateBytes = (r: Rotate): Uint8Array =>
  frame(DOMAIN.rotate, [key(r.R), key(r.from), key(r.to)]);

const idOf = (b: Uint8Array) => bytesToHex(sha256(b));
export const genesisId = (g: Genesis) => idOf(genesisBytes(g));
export const inviteId = (i: Invite) => idOf(inviteBytes(i));
export const joinId = (j: Join) => idOf(joinBytes(j));
export const rosterId = (r: Roster) => idOf(rosterBytes(r));
export const rotateId = (r: Rotate) => idOf(rotateBytes(r));

/** what a member signs to say yes to an object: its id, under one domain */
export const sigMessage = (id: string): Uint8Array => frame(DOMAIN.sig, [key(id)]);

/**
 * The run of the door's SPAKE2 that let a joiner in: the owner's salt, the
 * joiner's run id, the owner's message and the joiner's. Both sides hold all
 * four, and nobody else made that run.
 */
export const pakeHash = (salt: string, jid: string, x: string, y: string): string =>
  hash(DOMAIN.pake, [bytesOf(salt, 16), bytesOf(jid, 8), bytesOf(x, 33), bytesOf(y, 33)]);

/** a room's id: a commitment to its secret that does not say it */
export const roomId = (scope: string, secret: string): string =>
  hash(DOMAIN.room, [enc.encode(scope), bytesOf(secret, 32)]);

/** the new room secret's box to one member: bound to this rotation and to them */
export const rotateBoxAad = (rotate: string, member: string): Uint8Array =>
  frame(DOMAIN.rotateBox, [key(rotate), key(member)]);

// -- key setup (FROST DKG, context = R's id) ------------------------------------

/** `c_i`: member `i` (its place in R) commits to its fresh `s_i` in round one */
export const commitOf = (R: string, i: number, s: string): string =>
  hash(DOMAIN.commit, [key(R), u32(i), bytesOf(s, 32)]);

export interface R1 {
  R: string;
  member: string;
  /** the FROST round-one broadcast, hex */
  b: string;
  /** this member's X-Wing key for the setup, hex */
  x: string;
  c: string;
}

export const r1Id = (r: R1): string =>
  hash(DOMAIN.r1, [key(r.R), key(r.member), bytesOf(r.b), bytesOf(r.x), key(r.c)]);

/** `h1`: every round-one record a member used, in R's order */
export const h1Of = (R: string, r1s: string[]): string =>
  hash(DOMAIN.h1, [key(R), list(r1s.map(key))]);

export interface R2 {
  R: string;
  member: string;
  /** the FROST round-two packages, sealed by frost per recipient, hex */
  p: string[];
  /** `s_i` X-Wing sealed to each member, in R's order; empty for this member itself */
  s: string[];
  h1: string;
}

export const r2Id = (r: R2): string =>
  hash(DOMAIN.r2, [
    key(r.R),
    key(r.member),
    list(r.p.map(x => bytesOf(x))),
    list(r.s.map(x => bytesOf(x))),
    key(r.h1),
  ]);

/** the box of `s_i` from one member to another, bound to this setup */
export const revealAad = (R: string, from: string, to: string): Uint8Array =>
  frame(DOMAIN.reveal, [key(R), key(from), key(to)]);

/**
 * The viewing-key secret: `H("zafu-fvk-v1" ‖ R ‖ s_1 ‖ … ‖ s_n)`, in R's
 * order. Commit-then-reveal: nobody chooses it or biases it. The 32 bytes
 * are an Orchard SpendingKey as they are; the vanishing case that is not
 * one fails the same way on every device, and nothing is saved.
 */
export const skOf = (R: string, s: string[]): string =>
  hash(DOMAIN.sk, [key(R), ...s.map(x => bytesOf(x, 32))]);

/** what each member commits to once its keys are made: the setup, both rounds, the wallet */
export const fvkHash = (f: {
  R: string;
  r1: string[];
  r2: string[];
  pkp: string;
  ufvk: string;
  address: string;
}): string =>
  hash(DOMAIN.fvk, [
    key(f.R),
    list(f.r1.map(key)),
    list(f.r2.map(key)),
    bytesOf(f.pkp),
    enc.encode(f.ufvk),
    enc.encode(f.address),
  ]);
