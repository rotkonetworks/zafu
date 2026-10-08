/**
 * What a set of leaderless records says (zafu #110), as a pure function of
 * the set. The relay stores a set, not a log: it may withhold records, show
 * members different subsets, or hand them over in any order. So nothing here
 * reads an order. "First", "latest" and record position never decide a seat,
 * a roster or a rotation; two devices holding the same records reach the same
 * answer, and devices holding different subsets stall rather than disagree.
 *
 * - A seat comes from the room's base (the genesis creator, or the roster of
 *   the rotation that opened this room) or from a join both its invite's
 *   owner and the joiner signed, whose owner holds a seat. An invite answered
 *   twice is the owner's equivocation: neither seat counts, and every member
 *   who sees both shows it.
 * - A roster binds only with the signature of every member it names, each
 *   of whom holds a seat here. A member who signed two rosters for one
 *   genesis stops both, for everyone who sees it.
 * - A rotation binds only when its roster binds and every member of that
 *   roster signed the rotation.
 */

import {
  genesisId,
  inviteId,
  joinId,
  rosterId,
  rotateId,
  sigMessage,
  type Genesis,
  type Invite,
  type Join,
  type Roster,
  type Rotate,
} from './objects';

/** ed25519 verify over a message, `sig` and `key` hex; never throws */
export type Verify = (msg: Uint8Array, sig: string, key: string) => boolean;

export interface SignedInvite {
  i: Invite;
  sig: string;
}
/** a join with the joiner's signature and, once its owner answered, the owner's */
export interface SignedJoin {
  j: Join;
  js: string;
  os?: string;
}
export interface RosterSig {
  r: Roster;
  key: string;
  sig: string;
}
export interface RotateSig {
  rot: Rotate;
  r: Roster;
  key: string;
  sig: string;
}

export interface RoomRecords {
  G: Genesis;
  /** this room's id (objects roomId) */
  room: string;
  invites: SignedInvite[];
  joins: SignedJoin[];
  rosterSigs: RosterSig[];
  rotateSigs: RotateSig[];
}

export interface Membership {
  /** who holds a seat without a join here */
  base: string[];
  members: Set<string>;
  /** the owner who let each member in */
  by: Map<string, string>;
  /** invites their owner answered twice, with that owner: neither seat counts */
  twice: Map<string, string>;
}

export interface RosterView {
  r: Roster;
  id: string;
  /** members of it whose signature holds */
  signed: Set<string>;
  /** every member of it holds a seat here */
  seated: boolean;
  /** members of it who also signed another roster for its genesis: it stops */
  twice: Set<string>;
  bound: boolean;
}

export interface RotateView {
  rot: Rotate;
  id: string;
  roster: RosterView;
  signed: Set<string>;
  bound: boolean;
}

const signs = (verify: Verify, id: string, sig: string | undefined, key: string) =>
  !!sig && verify(sigMessage(id), sig, key);

const rotationsOf = (rotateSigs: RotateSig[], verify: Verify) => {
  const out = new Map<string, { rot: Rotate; r: Roster; signed: Set<string> }>();
  for (const s of rotateSigs) {
    let id: string;
    try {
      id = rotateId(s.rot);
      if (rosterId(s.r) !== s.rot.R) {
        continue;
      }
    } catch {
      continue;
    }
    if (!s.r.members.includes(s.key) || !signs(verify, id, s.sig, s.key)) {
      continue;
    }
    const v = out.get(id) ?? { rot: s.rot, r: s.r, signed: new Set<string>() };
    v.signed.add(s.key);
    out.set(id, v);
  }
  return out;
};

/**
 * The base of a room: its creator, or, in a room a rotation opened, the
 * members of that rotation's roster, once every one of them signed it. The
 * rotation records are posted into the room they open, so a newcomer reads
 * them like anyone else.
 */
export const baseOf = (rec: RoomRecords, verify: Verify): string[] => {
  const G = genesisId(rec.G);
  const opened = [...rotationsOf(rec.rotateSigs, verify).values()].filter(
    v => v.rot.to === rec.room && v.r.G === G && v.r.members.every(m => v.signed.has(m)),
  );
  // two rotations into one room cannot both be honest; such a room has only its creator
  return opened.length === 1 ? opened[0]!.r.members : [rec.G.creator];
};

export const membershipOf = (rec: RoomRecords, verify: Verify): Membership => {
  const G = genesisId(rec.G);
  const invites = new Map<string, Invite>();
  for (const { i, sig } of rec.invites) {
    try {
      const id = inviteId(i);
      if (i.G === G && signs(verify, id, sig, i.owner)) {
        invites.set(id, i);
      }
    } catch {
      // a malformed invite is not one
    }
  }
  const answers = new Map<string, Map<string, Join>>();
  for (const { j, js, os } of rec.joins) {
    const i = invites.get(j.I);
    let id: string;
    try {
      id = joinId(j);
    } catch {
      continue;
    }
    if (i && signs(verify, id, js, j.joiner) && signs(verify, id, os, i.owner)) {
      answers.set(j.I, (answers.get(j.I) ?? new Map()).set(id, j));
    }
  }
  const twice = new Map<string, string>();
  const once: [Invite, Join][] = [];
  for (const [I, js] of answers) {
    if (js.size > 1) {
      twice.set(I, invites.get(I)!.owner);
    } else {
      once.push([invites.get(I)!, [...js.values()][0]!]);
    }
  }
  const base = baseOf(rec, verify);
  const members = new Set(base);
  const by = new Map<string, string>();
  // a seat from a seat: whoever an owner with a seat let in, until nothing changes
  for (let grew = true; grew; ) {
    grew = false;
    for (const [i, j] of once) {
      if (members.has(i.owner) && !members.has(j.joiner)) {
        members.add(j.joiner);
        by.set(j.joiner, i.owner);
        grew = true;
      }
    }
  }
  return { base, members, by, twice };
};

/** every roster said in the room, with who signed it and whether it binds */
export const rostersOf = (rec: RoomRecords, m: Membership, verify: Verify): RosterView[] => {
  const out = new Map<string, RosterView>();
  for (const { r, key, sig } of rec.rosterSigs) {
    let id: string;
    try {
      id = rosterId(r);
    } catch {
      continue;
    }
    const v = out.get(id) ?? {
      r,
      id,
      signed: new Set<string>(),
      seated: r.members.every(k => m.members.has(k)),
      twice: new Set<string>(),
      bound: false,
    };
    if (r.members.includes(key) && signs(verify, id, sig, key)) {
      v.signed.add(key);
    }
    out.set(id, v);
  }
  const all = [...out.values()];
  for (const v of all) {
    for (const o of all) {
      if (o !== v && o.r.G === v.r.G) {
        o.signed.forEach(k => v.signed.has(k) && v.twice.add(k));
      }
    }
    v.bound = v.seated && !v.twice.size && v.r.members.every(k => v.signed.has(k));
  }
  return all;
};

/** rotations out of this room, each with its roster and who signed it */
export const rotationsFrom = (
  rec: RoomRecords,
  rosters: RosterView[],
  verify: Verify,
): RotateView[] => {
  const G = genesisId(rec.G);
  return [...rotationsOf(rec.rotateSigs, verify)]
    .filter(([, v]) => v.rot.from === rec.room && v.r.G === G)
    .map(([id, v]) => {
      const roster = rosters.find(x => x.id === v.rot.R) ?? {
        r: v.r,
        id: v.rot.R,
        signed: new Set<string>(),
        seated: false,
        twice: new Set<string>(),
        bound: false,
      };
      return {
        rot: v.rot,
        id,
        roster,
        signed: v.signed,
        bound: roster.bound && v.r.members.every(k => v.signed.has(k)),
      };
    });
};

/**
 * May `me` sign this roster: it names me, every member it names holds a seat
 * in my view, and I signed no other roster for its genesis in this room
 * (`before`: what I signed, kept before any signature leaves).
 */
export const maySignRoster = (
  r: Roster,
  me: string,
  m: Membership,
  before: string | undefined,
): boolean =>
  r.members.includes(me) &&
  r.members.every(k => m.members.has(k)) &&
  (before === undefined || before === rosterId(r));

/** May `me` sign this rotation: out of this room, to a roster I signed, and no other rotation of this room */
export const maySignRotate = (
  rot: Rotate,
  r: Roster,
  me: string,
  room: string,
  rosterBefore: string | undefined,
  before: string | undefined,
): boolean =>
  rot.from === room &&
  rot.R === rosterId(r) &&
  rosterBefore === rot.R &&
  r.members.includes(me) &&
  (before === undefined || before === rotateId(rot));
