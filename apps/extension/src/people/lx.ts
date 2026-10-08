/**
 * A leaderless group as this device holds it (zafu #110): its records read
 * into `@zafu/zirc/leaderless`, and the worker's part, which needs the room
 * key and so runs where the vault is:
 *
 *   - the owner of an invite co-signs the one join that came through its
 *     own door run, kept before the signature leaves (single use, strictly);
 *   - in a room made for a shared wallet, each member signs the roster of
 *     everyone seated once there are exactly n: typing the code, or making
 *     the wallet, was that member's yes. A wallet proposed from a chat, or a
 *     deal in a pair room (both people are seated: they exchanged cards), is
 *     signed by tapping "agree", which is the same signature;
 *   - a member signs at most one roster per genesis in a room, kept first,
 *     unless the later one supersedes the earlier before any keys exist;
 *   - removing someone before keys is a roster of everyone else plus a
 *     rotation to a new room secret, sealed to each remaining member. Each
 *     other remaining member says yes with one tap; when all did, they move
 *     and the removed one is told;
 *   - a wallet that filled up twice waits until an owner withdraws a join;
 *   - a group an older zafu made is upgraded by every member signing one
 *     roster of who is in, automatically, when they open it.
 *
 * Every decision is a function of the record set (see the package); this
 * file only decides what to try next.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { openXWing, sealXWing } from '@zafu/pq';
import { presenceEpoch } from '@zafu/zid';
import {
  frame,
  genesisId,
  inviteId,
  joinId,
  maySignRoster,
  maySignRotate,
  membershipOf,
  roomId,
  rostersOf,
  rotateBoxAad,
  rotateId,
  rotationsFrom,
  rosterId,
  sigMessage,
  sortKeys,
  upgradeId,
  withdrawId,
  type Genesis,
  type Membership,
  type RoomRecords,
  type Roster,
  type RosterView,
  type RotateView,
  type Upgrade,
  type Verify,
} from '@zafu/zirc/leaderless';
import type { XidKeys } from '../state/identity';
import {
  foldFrost,
  keepSaid,
  packFrost,
  readMsgs,
  roundsOf,
  walletGenesis,
  type Deal,
  type FrostBody,
  type Keygen,
  type LxBody,
} from './frost-room';
import { encodeWire } from './door';
import { inviteFor } from './door-run';
import { memberName, wordName } from './word-name';
import { RETENTION_MS, type PeopleApi, type PeopleService, type RecordHandler } from './service';
import type { GroupMember, PeopleRoom } from './vault';

export const verify: Verify = (msg, sig, key) => {
  try {
    return ed25519.verify(sig, msg, key);
  } catch {
    return false;
  }
};

const signId = (k: Pick<XidKeys, 'seed'>, id: string) =>
  bytesToHex(ed25519.sign(sigMessage(id), k.seed));

/** the joiner's proof to the invite's owner that it is the one the door run let in */
export const joinMac = (pakeKey: string, join: string): string =>
  bytesToHex(hmac(sha256, hexToBytes(pakeKey), frame('zafu-join-mac-v1', [hexToBytes(join)])));

export const roomIdOf = (room: Pick<PeopleRoom, 'appScope' | 'secret'>) =>
  roomId(room.appScope, room.secret);

/** a group an older zafu made: the genesis its upgrade is for, fixed by its tag and founder */
export const upgradeGenesis = (room: PeopleRoom): Genesis => ({
  purpose: 'chat',
  t: 0,
  n: 0,
  salt: room.group!.G,
  creator: room.group!.founder,
});

/** a group an older zafu made that is not upgraded yet */
export const isLegacy = (room: PeopleRoom) => room.kind === 'group' && !room.group?.g;

/** what this device signed in this room, if it is still this room */
const signedIn = (room: PeopleRoom) =>
  room.signed?.room === roomIdOf(room) ? room.signed : undefined;

/** a room's leaderless records; undefined for a pair room or a door */
export const recordsOf = (room: PeopleRoom): RoomRecords | undefined => {
  const G = room.group?.g ?? (room.group ? upgradeGenesis(room) : undefined);
  if (!G) {
    return undefined;
  }
  const rec: Required<RoomRecords> = {
    G,
    room: roomIdOf(room),
    invites: [],
    joins: [],
    rosterSigs: [],
    rotateSigs: [],
    withdraws: [],
    upgrades: [],
  };
  for (const { body: b } of readMsgs(room.frost?.msgs)) {
    if (b.t === 'i') {
      rec.invites.push({ i: b.i, sig: b.sig });
    } else if (b.t === 'join') {
      rec.joins.push({ j: b.j, js: b.js, ...(b.os ? { os: b.os } : {}) });
    } else if (b.t === 'rs') {
      rec.rosterSigs.push({ r: b.r, key: b.k, sig: b.sig });
    } else if (b.t === 'rot') {
      rec.rotateSigs.push({ rot: b.rot, r: b.r, key: b.k, sig: b.sig });
    } else if (b.t === 'wd') {
      rec.withdraws.push({ w: b.w, sig: b.sig });
    } else if (b.t === 'up') {
      rec.upgrades.push({ u: b.u, key: b.k, sig: b.sig });
    }
  }
  return rec;
};

/** some member already said its wallet commitment for this roster: too late to supersede it */
const madeIn = (room: PeopleRoom) => (R: string) =>
  !!room.frost?.mine?.[R]?.fh ||
  readMsgs(room.frost?.msgs).some(m => m.body.t === 'fvk' && m.body.id === R);

export interface LxView {
  m: Membership;
  rosters: RosterView[];
  rotations: RotateView[];
  /** the wallet geneses a roster here may make keys for: the room's own, and any proposed in it */
  wallets: Map<string, Genesis>;
  /** a deal's terms, by its wallet genesis */
  deals: Map<string, Deal>;
  /** geneses said twice with different terms: their wallets stop */
  twice: Set<string>;
  /** the room's own genesis, when it is a shared wallet made by codes */
  own?: string;
}

/**
 * What a room's records bind. A pair room has no joins: both people are
 * seated, so it needs `me` (this member's key in it).
 */
export const viewOf = (room: PeopleRoom, me?: string): LxView | undefined => {
  const pair = room.kind === 'pair' && room.pair?.peer && me ? [me, room.pair.peer] : undefined;
  const rec = pair
    ? {
        ...recordsOf({
          ...room,
          group: { G: '00'.repeat(16), founder: me!, mine: false, members: [] },
        })!,
      }
    : recordsOf(room);
  if (!rec) {
    return undefined;
  }
  const m: Membership = pair
    ? {
        base: pair,
        members: new Set(pair),
        by: new Map(),
        twice: new Map(),
        joins: new Map(),
        over: false,
      }
    : membershipOf(rec, verify);
  const rosters = rostersOf(rec, m, verify, madeIn(room));
  const wallets = new Map<string, Genesis>();
  const deals = new Map<string, Deal>();
  const said = new Map<string, string>();
  const twice = new Set<string>();
  const own = !pair && room.group?.g?.purpose === 'wallet' ? genesisId(room.group.g) : undefined;
  if (own) {
    wallets.set(own, room.group!.g!);
  }
  for (const { body } of readMsgs(room.frost?.msgs)) {
    if (body.t === 'g') {
      const terms = JSON.stringify(body.deal ?? null);
      if (said.has(body.id) && said.get(body.id) !== terms) {
        twice.add(body.id);
      }
      said.set(body.id, terms);
      wallets.set(body.id, body.g);
      if (body.deal) {
        deals.set(body.id, body.deal);
      }
    }
  }
  return {
    m,
    rosters,
    rotations: pair ? [] : rotationsFrom(rec, rosters, verify),
    wallets,
    deals,
    twice,
    ...(own ? { own } : {}),
  };
};

/**
 * The wallets being made in a room: each roster for a wallet genesis with
 * its n, and its rounds. A roster superseded by one that binds, or by one
 * this member signed, is not made here.
 */
export const keygensOf = (room: PeopleRoom, me?: string): Keygen[] => {
  const v = viewOf(room, me);
  if (!v) {
    return [];
  }
  const msgs = readMsgs(room.frost?.msgs);
  const atOf = (id: string) =>
    Math.min(...msgs.filter(m => m.body.id === id).map(m => m.at), Number.MAX_SAFE_INTEGER);
  const left = (rv: RosterView) =>
    v.rosters.some(o => o.r.supersedes === rv.id && (o.bound || (!!me && o.signed.has(me))));
  return v.rosters
    .flatMap(rv => {
      const G = v.wallets.get(rv.r.G);
      if (!G || G.n !== rv.r.members.length || left(rv)) {
        return [];
      }
      const rival = v.rosters.some(
        o => o !== rv && o.r.G === rv.r.G && o.signed.size > 0 && o.r.supersedes !== rv.id,
      );
      const rounds = roundsOf(room.frost?.msgs, rv.id, rv.r.members);
      if (v.twice.has(rv.r.G)) {
        rounds.split.add(G.creator);
      }
      const deal = v.deals.get(rv.r.G);
      return [
        {
          id: rv.id,
          G,
          k: G.t,
          members: rv.r.members,
          by: G.creator,
          at: Math.min(atOf(rv.id), atOf(rv.r.G)),
          agreed: rv.signed,
          byCode: rv.r.G === v.own,
          bound: rv.bound,
          rival,
          ...(deal ? { deal } : {}),
          ...rounds,
        },
      ];
    })
    .sort((a, b) => a.at - b.at);
};

/** a removal waiting on this member's yes: who asked, whom it takes off, when */
export interface Removal {
  id: string;
  by?: string;
  out: string[];
  at: number;
}

/** removals someone asked for that wait on `me`, within the room's two days, not set aside */
export const removalsFor = (room: PeopleRoom, me: string, nowMs: number): Removal[] => {
  const v = viewOf(room);
  if (!v || room.group?.gone) {
    return [];
  }
  const msgs = readMsgs(room.frost?.msgs);
  return v.rotations.flatMap(x => {
    const at = Math.min(...msgs.filter(m => m.body.id === x.id).map(m => m.at));
    return !x.bound &&
      x.roster.r.members.includes(me) &&
      !x.signed.has(me) &&
      !room.notNow?.includes(x.id) &&
      nowMs - at * 1000 < RETENTION_MS
      ? [
          {
            id: x.id,
            ...(x.signed.size ? { by: [...x.signed][0]! } : {}),
            out: [...v.m.members].filter(k => !x.roster.r.members.includes(k)),
            at,
          },
        ]
      : [];
  });
};

/**
 * A shared wallet with more seats than it has: who is asked to withdraw. Of
 * the joins that let in someone who let nobody in (a later seat, not one the
 * others came through), the one with the lexicographically largest id. A
 * hint for what to try, never a rule: any owner's withdraw counts the same.
 */
export const overOf = (room: PeopleRoom): { join: string; owner: string } | undefined => {
  const v = viewOf(room);
  if (!v?.m.over) {
    return undefined;
  }
  const owners = new Set([...v.m.joins.values()].map(j => j.owner));
  const [join] = [...v.m.joins]
    .filter(([, j]) => !owners.has(j.joiner))
    .map(([id]) => id)
    .sort()
    .reverse();
  return join ? { join, owner: v.m.joins.get(join)!.owner } : undefined;
};

/** the seats as screens show them: the creator first, each with the name and seal they said */
export const seatsOf = (room: PeopleRoom, m: Membership): GroupMember[] => {
  const g = room.group!;
  return [...m.members]
    .sort((a, b) => (a === g.founder ? -1 : b === g.founder ? 1 : a < b ? -1 : 1))
    .map(key => ({
      key,
      name: memberName(key, g.names?.[key]),
      ...(g.seals?.[key] ? { sealKey: g.seals[key] } : {}),
      at: room.createdAt,
    }));
};

/** the shared wallet a code made: the room's own genesis, and everyone seated, once there are n */
export const roomRosterOf = (room: PeopleRoom, m: Membership): Roster | undefined => {
  const g = room.group?.g;
  return g?.purpose === 'wallet' && !m.over && m.members.size === g.n
    ? { G: genesisId(g), members: sortKeys([...m.members]) }
    : undefined;
};

export interface LxDeps {
  keys: (room: PeopleRoom) => Promise<XidKeys>;
  now: () => number;
}

/** said in the room, and kept here at once: the next step need not wait for the relay to echo it */
const post = async (api: PeopleApi, roomId: string, body: FrostBody, from = '') => {
  for (const b of await packFrost(body)) {
    await api.send(roomId, b, 'action');
  }
  if (body.t !== 'all') {
    const at = Math.floor(api.now() / 1000);
    await api.updateRoom(roomId, r => keepSaid(r, { from, at, mid: 'said', body }));
  }
  return body;
};

const bundleId = () => bytesToHex(crypto.getRandomValues(new Uint8Array(16)));

export const createLeaderless = (deps: LxDeps) => {
  /**
   * Keep what this device signs before the signature leaves: `ok` decides
   * from what is kept now, `next` is kept when it holds.
   */
  const keep = async (
    api: PeopleApi,
    room: PeopleRoom,
    ok: (s: NonNullable<PeopleRoom['signed']>) => boolean,
    next: (s: NonNullable<PeopleRoom['signed']>) => NonNullable<PeopleRoom['signed']>,
    more: (r: PeopleRoom) => PeopleRoom = r => r,
  ) => {
    const here = roomIdOf(room);
    let held = false;
    await api.updateRoom(room.id, x => {
      const s = x.signed?.room === here ? x.signed : { room: here };
      held = ok(s);
      return held ? more({ ...x, signed: next(s) }) : x;
    });
    return held;
  };

  /**
   * Sign a roster, once: what this device signed for its genesis in this
   * room is kept before the signature leaves, and a different one is refused
   * unless it supersedes it before keys.
   */
  const signRoster = async (api: PeopleApi, room: PeopleRoom, r: Roster) => {
    const k = await deps.keys(room);
    const v = viewOf(room, k.pubkey);
    const id = rosterId(r);
    const made = madeIn(room);
    if (!v || !maySignRoster(r, k.pubkey, v.m, undefined, made)) {
      throw new Error('not everyone in it is in this group');
    }
    const held = await keep(
      api,
      room,
      s => maySignRoster(r, k.pubkey, v.m, s.r?.[r.G], made),
      s => ({ ...s, r: { ...s.r, [r.G]: id } }),
    );
    if (!held) {
      throw new Error('you already agreed to another roster here');
    }
    await post(api, room.id, { t: 'rs', v: 2, id, r, k: k.pubkey, sig: signId(k, id) });
  };

  /** the invite's owner: co-sign the join its own door run let in, and show newcomers the seats */
  const cosign = async (api: PeopleApi, room: PeopleRoom, me: XidKeys) => {
    const msgs = readMsgs(room.frost?.msgs);
    const mine = new Map(
      msgs.flatMap(({ body: b }) => (b.t === 'i' && b.i.owner === me.pubkey ? [[b.id, b.i]] : [])),
    );
    const halves = msgs.flatMap(({ body: b }) =>
      b.t === 'join' && !b.os && b.jm && mine.has(b.id) ? [b] : [],
    );
    const signed = new Set(
      msgs.flatMap(({ body: b }) => (b.t === 'join' && b.os ? [joinId(b.j)] : [])),
    );
    const said: FrostBody[] = [];
    for (const h of halves) {
      const i = mine.get(h.id)!;
      const id = joinId(h.j);
      const door = (await api.rooms()).find(
        r =>
          r.kind === 'door' &&
          r.door?.role === 'host' &&
          r.signer.G === room.signer.G &&
          r.door.salt === i.salt,
      );
      const d = door?.door;
      if (
        !d?.mk ||
        d.th !== h.j.th ||
        joinMac(d.mk, id) !== h.jm ||
        !verify(sigMessage(id), h.js, h.j.joiner) ||
        (d.cosigned && d.cosigned !== id)
      ) {
        continue;
      }
      if (!d.cosigned) {
        // single use: the one join this invite answers is kept before the signature leaves
        let won = false;
        await api.updateRoom(door!.id, x => {
          won = !x.door?.cosigned || x.door.cosigned === id;
          return won ? { ...x, door: { ...x.door!, cosigned: id } } : x;
        });
        if (!won) {
          continue;
        }
      } else if (signed.has(id)) {
        continue;
      }
      said.push(
        await post(api, room.id, {
          t: 'join',
          v: 2,
          id: h.id,
          j: h.j,
          js: h.js,
          os: signId(me, id),
        }),
      );
    }
    if (said.length) {
      // the relay keeps two days: a newcomer reads every seat from this, not from the past
      const items = msgs.flatMap(({ body: b }) =>
        b.t === 'i' ||
        (b.t === 'join' && b.os) ||
        b.t === 'rot' ||
        b.t === 'g' ||
        b.t === 'rs' ||
        b.t === 'wd' ||
        b.t === 'up'
          ? [b]
          : [],
      );
      if (items.length) {
        await post(api, room.id, { t: 'all', v: 2, id: bundleId(), items });
      }
    }
    return said;
  };

  /** what this member calls itself here, and the key a new room secret is sealed to */
  const sayHello = (api: PeopleApi, room: PeopleRoom, me: XidKeys) =>
    api.send(
      room.id,
      encodeWire({
        kind: 'ask',
        key: me.pubkey,
        name: room.nick || wordName(me.pubkey),
        seal: me.xwingPublicKey,
      }),
      'action',
    );

  /** a rotation out of this room bound: move to its room, or, left out of it, say so */
  const follow = async (api: PeopleApi, room: PeopleRoom, v: LxView, me: XidKeys) => {
    const bound = v.rotations.filter(r => r.bound);
    const into = bound.filter(r => r.roster.r.members.includes(me.pubkey));
    const g = room.group!;
    if (bound.length && !into.length) {
      await api.updateRoom(room.id, x => ({ ...x, group: { ...x.group!, gone: true } }));
      await api.note(room.id, {
        hash: `n:gone:${bound[0]!.id}`,
        body: "you're no longer in this group",
        ts: Math.floor(deps.now() / 1000),
      });
      return true;
    }
    // two rotations that both take this member cannot both be honest: it waits
    if (into.length !== 1) {
      return false;
    }
    const rot = into[0]!;
    let secret = g.next?.rot === rot.id ? g.next.secret : undefined;
    for (const { body: b } of readMsgs(room.frost?.msgs)) {
      const box = b.t === 'rot' && b.id === rot.id ? b.box?.[me.pubkey] : undefined;
      if (secret || !box) {
        continue;
      }
      try {
        const s = bytesToHex(
          openXWing(me.xwingSeed, hexToBytes(box), rotateBoxAad(rot.id, me.pubkey)),
        );
        // the box must hold the very secret every member signed the commitment of
        secret = roomId(room.appScope, s) === rot.rot.to ? s : undefined;
      } catch {
        // a box that does not open is not one
      }
    }
    if (!secret) {
      return false;
    }
    const gone = [...v.m.members].filter(k => !rot.roster.r.members.includes(k));
    // the new room shows who it seats: the rotation and its roster, signed by all of them
    const proof = readMsgs(room.frost?.msgs).flatMap(({ body: b }): LxBody[] =>
      b.t === 'rot' && b.id === rot.id
        ? [{ t: 'rot', v: 2, id: b.id, rot: b.rot, r: b.r, k: b.k, sig: b.sig }]
        : (b.t === 'rs' && b.id === rot.rot.R) || b.t === 'up' || b.t === 'g'
          ? [b]
          : [],
    );
    const s = secret;
    await api.updateRoom(room.id, x => ({
      ...x,
      secret: s,
      head: undefined,
      since: presenceEpoch(Math.floor(deps.now() / 1000)),
      frost: { msgs: [], parts: {}, ...(x.frost?.mine ? { mine: x.frost.mine } : {}) },
      signed: undefined,
      notNow: undefined,
      group: { ...x.group!, next: undefined, told: undefined },
    }));
    await post(api, room.id, { t: 'all', v: 2, id: bundleId(), items: proof });
    await sayHello(api, room, me);
    // this member's codes still open: their invites are said again where a joiner will now land
    const moved = (await api.room(room.id))!;
    for (const d of await api.rooms()) {
      if (
        d.kind === 'door' &&
        d.door?.role === 'host' &&
        d.door.owner === me.pubkey &&
        !d.door.admitted &&
        d.signer.G === g.G &&
        (d.until ?? 0) > deps.now()
      ) {
        const i = inviteFor(d, moved, me.pubkey);
        const id = inviteId(i);
        await post(api, room.id, { t: 'i', v: 2, id, i, sig: signId(me, id) });
      }
    }
    for (const k of gone) {
      await api.note(room.id, {
        hash: `n:left:${rot.id}:${k}`,
        body: `${memberName(k, g.names?.[k])} is no longer in the group`,
        ts: Math.floor(deps.now() / 1000),
      });
    }
    return true;
  };

  /**
   * A group an older zafu made, opened here: this member signs one upgrade
   * naming everyone it holds as in, by itself, and once every one of them
   * signed it the group is leaderless. Nothing from the old log is evidence:
   * only their signatures seat them.
   */
  const upgrade = async (api: PeopleApi, room: PeopleRoom) => {
    const g = room.group!;
    const me = await deps.keys(room);
    const G = upgradeGenesis(room);
    const members = sortKeys([g.founder, ...g.members.map(m => m.key)]);
    if (!members.includes(me.pubkey)) {
      return;
    }
    const u: Upgrade = { G: genesisId(G), members };
    const id = upgradeId(u);
    if (!signedIn(room)?.up) {
      const held = await keep(
        api,
        room,
        s => !s.up,
        s => ({ ...s, up: id }),
      );
      if (held) {
        await post(api, room.id, { t: 'up', v: 2, id, u, k: me.pubkey, sig: signId(me, id) });
        await sayHello(api, room, me);
      }
    }
    // bound: every member it names signed it; the base it gives is read by the package
    const sigs = new Map<string, Set<string>>();
    let done: Upgrade | undefined;
    for (const { body: b } of readMsgs(room.frost?.msgs)) {
      if (b.t === 'up' && b.u.G === u.G && verify(sigMessage(b.id), b.sig, b.k)) {
        const k = (sigs.get(b.id) ?? new Set()).add(b.k);
        sigs.set(b.id, k);
        done = b.u.members.every(x => k.has(x)) ? b.u : done;
      }
    }
    if (done) {
      const m = membershipOf(recordsOf(room)!, verify);
      await api.updateRoom(room.id, x => ({
        ...x,
        group: { ...x.group!, g: G, members: seatsOf(x, m), told: m.members.size },
      }));
    }
  };

  /** after the fold: what this device can move forward in a leaderless room */
  const act = async (seen: PeopleRoom, before: PeopleRoom, api: PeopleApi): Promise<boolean> => {
    const g = seen.group!;
    const me = await deps.keys(seen);
    // a seat this device just co-signed counts in this pass, not the next
    const room = (await cosign(api, seen, me)).reduce(
      (r, body) => keepSaid(r, { from: me.pubkey, at: 0, mid: 'said', body }),
      seen,
    );
    const v = viewOf(room)!;
    if (await follow(api, room, v, me)) {
      return true;
    }
    const signed = signedIn(room);
    const r = roomRosterOf(room, v.m);
    // liveness only: another member's code still open may yet fill a seat twice, so wait for it
    const msgs = readMsgs(room.frost?.msgs);
    const answered = new Set(msgs.flatMap(({ body: b }) => (b.t === 'join' ? [b.id] : [])));
    const open = msgs.some(
      ({ body: b }) =>
        b.t === 'i' &&
        b.i.owner !== me.pubkey &&
        !answered.has(b.id) &&
        b.i.expiry * 1000 > deps.now(),
    );
    if (r && !open && !signed?.r?.[r.G] && v.m.members.has(me.pubkey)) {
      await signRoster(api, room, r).catch(() => undefined);
    }
    // a signature the room does not show (a post that failed, a record let go) is said again
    for (const id of Object.values(signed?.r ?? {})) {
      const rv = v.rosters.find(x => x.id === id);
      if (rv && !rv.signed.has(me.pubkey)) {
        await post(api, room.id, { t: 'rs', v: 2, id, r: rv.r, k: me.pubkey, sig: signId(me, id) });
      }
    }
    const seats = seatsOf(room, v.m);
    const was = new Set(g.members.map(x => x.key));
    const came = seats.filter(x => !was.has(x.key));
    if (came.length || seats.length !== g.members.length) {
      await api.updateRoom(room.id, x => ({
        ...x,
        group: { ...x.group!, members: seatsOf(x, v.m) },
      }));
      const doors = (await api.rooms()).filter(
        d => d.kind === 'door' && d.door?.role === 'host' && d.signer.G === g.G,
      );
      for (const x of came) {
        if (x.key === me.pubkey) {
          continue;
        }
        const door =
          v.m.by.get(x.key) === me.pubkey ? doors.find(d => d.door!.cosigned) : undefined;
        const words = door?.door?.answered?.find(a => a.jid === door.door!.admitted)?.words;
        await api.note(room.id, {
          hash: `n:join:${x.key}`,
          body: `${x.name} joined${words ? ` with your code · words to compare: ${words}` : ''}`,
          ts: Math.floor(deps.now() / 1000),
        });
      }
    }
    // a newcomer may have come after the relay let our hello go: said once more per new seat
    if ((g.told ?? 0) < v.m.members.size && v.m.members.has(me.pubkey)) {
      await sayHello(api, room, me);
      await api.updateRoom(room.id, x => ({
        ...x,
        group: { ...x.group!, told: v.m.members.size },
      }));
    }
    // said once, on the pass that brought it: what was already there was said before
    const prior = viewOf(before);
    for (const [I, t] of v.m.twice) {
      if (prior?.m.twice.has(I)) {
        continue;
      }
      await api.note(room.id, {
        hash: `n:twice:${t}`,
        body: `${memberName(t, g.names?.[t])} let two people in with one code · neither seat counts`,
        ts: Math.floor(deps.now() / 1000),
      });
    }
    return false;
  };

  /** the room handler around the fold: a room that moved keeps nothing of the old room's pass */
  const handler =
    (fold: typeof foldFrost): RecordHandler =>
    async (room, records, api) => {
      const patch = await fold(room, records);
      if (room.kind !== 'group' || room.group?.gone) {
        return patch;
      }
      const seen = patch ? patch(room) : room;
      if (isLegacy(room)) {
        await upgrade(api, seen);
        return patch;
      }
      return (await act(seen, room, api)) ? undefined : patch;
    };

  /** a room that makes leaderless decisions: an upgraded group, or a pair room with its other person */
  const lxRoom = async (svc: PeopleService, roomId: string) => {
    const room = await svc.api.room(roomId);
    if (room?.group?.gone) {
      throw new Error("you're no longer in this group");
    }
    if (room && (room.group?.g || (room.kind === 'pair' && room.pair?.peer))) {
      return room;
    }
    throw new Error('upgrading · waits for everyone here');
  };

  /**
   * Remove someone before keys: a roster of everyone else (superseding the
   * one this member signed, if any, while no keys exist for it), and a
   * rotation to a new room secret sealed to each of them. Both bind when
   * every remaining member signed; this device signs both now.
   */
  const remove = async (svc: PeopleService, where: string, key: string) => {
    const room = await lxRoom(svc, where);
    const v = viewOf(room)!;
    const me = await deps.keys(room);
    if (!v.m.members.has(key) || key === me.pubkey) {
      return { ok: true };
    }
    const g = room.group!;
    const Gid = genesisId(g.g!);
    const before = signedIn(room)?.r?.[Gid];
    if (before && madeIn(room)(before)) {
      throw new Error('the keys are made · removing someone now means a new wallet');
    }
    const r: Roster = {
      G: Gid,
      members: sortKeys([...v.m.members].filter(k => k !== key)),
      ...(before ? { supersedes: before } : {}),
    };
    const seals = r.members.filter(k => k !== me.pubkey).map(k => [k, g.seals?.[k]] as const);
    if (seals.some(([, s]) => !s)) {
      throw new Error('not everyone here can be reached yet · please try again in a moment');
    }
    const secret = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const here = roomIdOf(room);
    const rot = { R: rosterId(r), from: here, to: roomId(room.appScope, secret) };
    const id = rotateId(rot);
    const made = madeIn(room);
    const held = await keep(
      svc.api,
      room,
      s =>
        maySignRoster(r, me.pubkey, v.m, s.r?.[r.G], made) &&
        maySignRotate(rot, r, me.pubkey, here, rot.R, s.rot),
      s => ({ ...s, r: { ...s.r, [r.G]: rot.R }, rot: id }),
      x => ({ ...x, group: { ...x.group!, next: { rot: id, secret } } }),
    );
    if (!held) {
      throw new Error('another removal waits here · please settle that one first');
    }
    const box = Object.fromEntries(
      seals.map(([k, s]) => [
        k,
        bytesToHex(sealXWing(hexToBytes(s!), hexToBytes(secret), rotateBoxAad(id, k))),
      ]),
    );
    await post(svc.api, room.id, {
      t: 'rs',
      v: 2,
      id: rot.R,
      r,
      k: me.pubkey,
      sig: signId(me, rot.R),
    });
    await post(svc.api, room.id, {
      t: 'rot',
      v: 2,
      id,
      rot,
      r,
      k: me.pubkey,
      sig: signId(me, id),
      box,
    });
    void svc.api.sync(room.id).catch(() => undefined);
    return { ok: true };
  };

  /** "agree" to a removal someone asked for: this member signs its roster and its rotation */
  const agreeRemove = async (svc: PeopleService, where: string, id: string) => {
    const room = await lxRoom(svc, where);
    const me = await deps.keys(room);
    if (!removalsFor(room, me.pubkey, deps.now()).some(x => x.id === id)) {
      throw new Error('this request has closed');
    }
    const x = viewOf(room)!.rotations.find(y => y.id === id)!;
    await signRoster(svc.api, room, x.roster.r);
    const here = roomIdOf(room);
    const held = await keep(
      svc.api,
      room,
      s => maySignRotate(x.rot, x.roster.r, me.pubkey, here, s.r?.[x.roster.r.G], s.rot),
      s => ({ ...s, rot: id }),
    );
    if (!held) {
      throw new Error('another removal waits here · please settle that one first');
    }
    await post(svc.api, room.id, {
      t: 'rot',
      v: 2,
      id,
      rot: x.rot,
      r: x.roster.r,
      k: me.pubkey,
      sig: signId(me, id),
    });
    void svc.api.sync(room.id).catch(() => undefined);
    return { ok: true };
  };

  return {
    handler,
    ops: {
      /** "agree": this member signs a wallet's roster */
      'lx-agree': async (r: Record<string, unknown>, svc: PeopleService) => {
        const room = await lxRoom(svc, String(r['roomId']));
        const me = await deps.keys(room);
        const rv = viewOf(room, me.pubkey)!.rosters.find(x => x.id === String(r['id']));
        if (!rv) {
          throw new Error('nothing to agree to yet');
        }
        await signRoster(svc.api, room, rv.r);
        void svc.api.sync(room.id).catch(() => undefined);
        return { ok: true };
      },
      /**
       * "make it a shared wallet" (or again, or without someone), or a deal in
       * a pair room: a wallet genesis, the deal's terms said with it, and its
       * roster, signed
       */
      'lx-wallet': async (r: Record<string, unknown>, svc: PeopleService) => {
        const room = await lxRoom(svc, String(r['roomId']));
        const members = Array.isArray(r['members']) ? r['members'].map(String) : [];
        const k = Number(r['k']);
        const me = await deps.keys(room);
        const G = walletGenesis(members, k, me.pubkey);
        const id = genesisId(G);
        const deal = r['deal'] as Deal | undefined;
        await post(svc.api, room.id, { t: 'g', v: 2, id, g: G, ...(deal ? { deal } : {}) });
        await signRoster(svc.api, room, { G: id, members: sortKeys(members) });
        void svc.api.sync(room.id).catch(() => undefined);
        return { id };
      },
      /** a group an older zafu made, opened: this member signs its upgrade */
      'lx-upgrade': async (r: Record<string, unknown>, svc: PeopleService) => {
        const room = await svc.api.room(String(r['roomId']));
        if (room && isLegacy(room) && !room.group?.gone) {
          await upgrade(svc.api, room);
        }
        return { ok: true };
      },
      'group-remove': (r: Record<string, unknown>, svc: PeopleService) =>
        remove(svc, `g:${String(r['G'])}`, String(r['key'])),
      'lx-agree-remove': (r: Record<string, unknown>, svc: PeopleService) =>
        agreeRemove(svc, String(r['roomId']), String(r['id'])),
      /** "not now" to a removal: set aside on this device, never said */
      'lx-not-now': async (r: Record<string, unknown>, svc: PeopleService) => {
        const id = String(r['id']);
        await svc.api.updateRoom(String(r['roomId']), x => ({
          ...x,
          notNow: [...new Set([...(x.notNow ?? []), id])].slice(-50),
        }));
        return { ok: true };
      },
      /** "withdraw my code": the owner takes back the seat its join gave, when the wallet filled up twice */
      'lx-withdraw': async (r: Record<string, unknown>, svc: PeopleService) => {
        const room = await lxRoom(svc, String(r['roomId']));
        const me = await deps.keys(room);
        const join = String(r['join']);
        const v = viewOf(room)!;
        if (!v.m.over || v.m.joins.get(join)?.owner !== me.pubkey) {
          throw new Error('nothing of yours to withdraw here');
        }
        const w = { join };
        const id = withdrawId(w);
        await post(svc.api, room.id, { t: 'wd', v: 2, id, w, sig: signId(me, id) });
        void svc.api.sync(room.id).catch(() => undefined);
        return { ok: true };
      },
    },
  };
};
