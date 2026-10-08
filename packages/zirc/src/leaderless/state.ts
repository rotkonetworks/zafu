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
  type Upgrade,
  type Withdraw,
  upgradeId,
  withdrawId,
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

export interface WithdrawSig {
  w: Withdraw;
  sig: string;
}
export interface UpgradeSig {
  u: Upgrade;
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
  withdraws?: WithdrawSig[];
  upgrades?: UpgradeSig[];
}

export interface Membership {
  /** who holds a seat without a join here */
  base: string[];
  members: Set<string>;
  /** the owner who let each member in */
  by: Map<string, string>;
  /** invites their owner answered twice, with that owner: neither seat counts */
  twice: Map<string, string>;
  /** the seats joins gave, by join id: who let whom in */
  joins: Map<string, { owner: string; joiner: string }>;
  /** a shared wallet with more seats than it has: no roster until an owner withdraws a join */
  over: boolean;
}

export interface RosterView {
  r: Roster;
  id: string;
  /** members of it whose signature holds */
  signed: Set<string>;
  /** every member of it holds a seat here */
  seated: boolean;
  /** members of it who also signed another roster for its genesis, not one superseding the other: it stops */
  twice: Set<string>;
  /** a roster that binds replaces this one (a removal before keys) */
  superseded: boolean;
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
 * The base of a room: its creator; in a room a rotation opened, the members
 * of that rotation's roster, once every one of them signed it; in a group an
 * older zafu made, the members of its upgrade, once every one of them signed
 * it. The records are posted into the room, so a newcomer reads them like
 * anyone else.
 */
export const baseOf = (rec: RoomRecords, verify: Verify): string[] => {
  const G = genesisId(rec.G);
  const opened = [...rotationsOf(rec.rotateSigs, verify).values()].filter(
    v => v.rot.to === rec.room && v.r.G === G && v.r.members.every(m => v.signed.has(m)),
  );
  if (opened.length) {
    // two rotations into one room cannot both be honest; such a room has only its creator
    return opened.length === 1 ? opened[0]!.r.members : [rec.G.creator];
  }
  const ups = new Map<string, { u: Upgrade; signed: Set<string> }>();
  for (const { u, key, sig } of rec.upgrades ?? []) {
    let id: string;
    try {
      id = upgradeId(u);
    } catch {
      continue;
    }
    if (u.G === G && u.members.includes(key) && signs(verify, id, sig, key)) {
      const v = ups.get(id) ?? { u, signed: new Set<string>() };
      v.signed.add(key);
      ups.set(id, v);
    }
  }
  const upgraded = [...ups.values()].filter(v => v.u.members.every(k => v.signed.has(k)));
  return upgraded.length === 1 ? upgraded[0]!.u.members : [rec.G.creator];
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
  const once: [Invite, Join, string][] = [];
  for (const [I, js] of answers) {
    if (js.size > 1) {
      twice.set(I, invites.get(I)!.owner);
    } else {
      const [[id, j]] = [...js] as [[string, Join]];
      once.push([invites.get(I)!, j, id]);
    }
  }
  const base = baseOf(rec, verify);
  // a seat from a seat: whoever an owner with a seat let in, until nothing changes
  const seat = (without: Set<string>) => {
    const members = new Set(base);
    const by = new Map<string, string>();
    const joins = new Map<string, { owner: string; joiner: string }>();
    for (let grew = true; grew; ) {
      grew = false;
      for (const [i, j, id] of once) {
        if (!without.has(id) && members.has(i.owner) && !members.has(j.joiner)) {
          members.add(j.joiner);
          by.set(j.joiner, i.owner);
          joins.set(id, { owner: i.owner, joiner: j.joiner });
          grew = true;
        }
      }
    }
    return { members, by, joins };
  };
  const all = seat(new Set());
  const n = rec.G.purpose === 'wallet' ? rec.G.n : Infinity;
  if (all.members.size <= n) {
    return { base, ...all, twice, over: false };
  }
  // filled up twice: a join its own owner withdrew no longer counts, and only then
  const owners = new Map(once.map(([i, , id]) => [id, i.owner]));
  const withdrawn = new Set(
    (rec.withdraws ?? []).flatMap(({ w, sig }) => {
      const owner = owners.get(w.join);
      try {
        return owner && signs(verify, withdrawId(w), sig, owner) ? [w.join] : [];
      } catch {
        return [];
      }
    }),
  );
  const left = seat(withdrawn);
  return { base, ...left, twice, over: left.members.size > n };
};

/**
 * Every roster said in the room, with who signed it and whether it binds.
 * `made(R)`: some member already said its wallet commitment for R; a roster
 * superseding R is then too late and never binds.
 */
export const rostersOf = (
  rec: RoomRecords,
  m: Membership,
  verify: Verify,
  made: (R: string) => boolean = () => false,
): RosterView[] => {
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
      superseded: false,
      bound: false,
    };
    if (r.members.includes(key) && signs(verify, id, sig, key)) {
      v.signed.add(key);
    }
    out.set(id, v);
  }
  const all = [...out.values()];
  const chained = (a: RosterView, b: RosterView) =>
    a.r.supersedes === b.id || b.r.supersedes === a.id;
  for (const v of all) {
    for (const o of all) {
      if (o !== v && o.r.G === v.r.G && !chained(o, v)) {
        o.signed.forEach(k => v.signed.has(k) && v.twice.add(k));
      }
    }
    v.bound =
      v.seated &&
      !v.twice.size &&
      !(v.r.supersedes && made(v.r.supersedes)) &&
      v.r.members.every(k => v.signed.has(k));
  }
  for (const v of all) {
    v.superseded = all.some(o => o.bound && o.r.supersedes === v.id);
    v.bound &&= !v.superseded;
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
        superseded: false,
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
 * (`before`: what I signed, kept before any signature leaves) unless this one
 * supersedes it, before any wallet commitment for it exists (`made`).
 */
export const maySignRoster = (
  r: Roster,
  me: string,
  m: Membership,
  before: string | undefined,
  made: (R: string) => boolean = () => false,
): boolean =>
  r.members.includes(me) &&
  r.members.every(k => m.members.has(k)) &&
  (r.supersedes === undefined || !made(r.supersedes)) &&
  (before === undefined || before === rosterId(r) || before === r.supersedes);

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
