/**
 * A leaderless group as this device holds it (zafu #110): its records read
 * into `@zafu/zirc/leaderless`, and the worker's part, which needs the room
 * key and so runs where the vault is:
 *
 *   - the owner of an invite co-signs the one join that came through its
 *     own door run, kept before the signature leaves (single use, strictly);
 *   - in a room made for a shared wallet, each member signs the roster of
 *     everyone seated once there are exactly n: typing the code, or making
 *     the wallet, was that member's yes. A wallet proposed from a chat is
 *     signed by tapping "agree", which is the same signature;
 *   - a member signs at most one roster per genesis in a room, kept first;
 *   - removing someone before keys is a roster of everyone else plus a
 *     rotation to a new room secret, sealed to each remaining member; when
 *     both bind, the remaining members move and the removed one is told.
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
  type Genesis,
  type Membership,
  type RoomRecords,
  type Roster,
  type RosterView,
  type RotateView,
  type Verify,
} from '@zafu/zirc/leaderless';
import type { XidKeys } from '../state/identity';
import {
  foldFrost,
  packFrost,
  readMsgs,
  roundsOf,
  walletGenesis,
  type FrostBody,
  type Keygen,
  type LxBody,
} from './frost-room';
import { encodeWire } from './door';
import { inviteFor } from './door-run';
import { memberName, wordName } from './word-name';
import type { PeopleApi, PeopleService, RecordHandler } from './service';
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

/** a room's leaderless records; undefined for a group an older zafu made, or a pair room */
export const recordsOf = (room: PeopleRoom): RoomRecords | undefined => {
  const G = room.group?.g;
  if (!G) {
    return undefined;
  }
  const rec: RoomRecords = {
    G,
    room: roomIdOf(room),
    invites: [],
    joins: [],
    rosterSigs: [],
    rotateSigs: [],
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
    }
  }
  return rec;
};

export interface LxView {
  rec: RoomRecords;
  m: Membership;
  rosters: RosterView[];
  rotations: RotateView[];
  /** the wallet geneses a roster here may make keys for: the room's own, and any proposed in it */
  wallets: Map<string, Genesis>;
}

export const viewOf = (room: PeopleRoom): LxView | undefined => {
  const rec = recordsOf(room);
  if (!rec) {
    return undefined;
  }
  const m = membershipOf(rec, verify);
  const rosters = rostersOf(rec, m, verify);
  const wallets = new Map<string, Genesis>();
  if (rec.G.purpose === 'wallet') {
    wallets.set(genesisId(rec.G), rec.G);
  }
  for (const { body } of readMsgs(room.frost?.msgs)) {
    if (body.t === 'g') {
      wallets.set(body.id, body.g);
    }
  }
  return { rec, m, rosters, rotations: rotationsFrom(rec, rosters, verify), wallets };
};

/** the wallets being made in a room: each roster for a wallet genesis with its n, and its rounds */
export const keygensOf = (room: PeopleRoom): Keygen[] => {
  const v = viewOf(room);
  if (!v) {
    return [];
  }
  const msgs = readMsgs(room.frost?.msgs);
  const atOf = (id: string) =>
    Math.min(...msgs.filter(m => m.body.id === id).map(m => m.at), Number.MAX_SAFE_INTEGER);
  return v.rosters
    .flatMap(rv => {
      const G = v.wallets.get(rv.r.G);
      if (!G || G.n !== rv.r.members.length) {
        return [];
      }
      const rival = v.rosters.some(o => o !== rv && o.r.G === rv.r.G && o.signed.size > 0);
      const at = Math.min(atOf(rv.id), atOf(rv.r.G));
      return [
        {
          id: rv.id,
          G,
          k: G.t,
          members: rv.r.members,
          by: G.creator,
          at,
          agreed: rv.signed,
          byCode: rv.r.G === genesisId(v.rec.G),
          bound: rv.bound,
          rival,
          ...roundsOf(room.frost?.msgs, rv.id, rv.r.members),
        },
      ];
    })
    .sort((a, b) => a.at - b.at);
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
  return g?.purpose === 'wallet' && m.members.size === g.n
    ? { G: genesisId(g), members: sortKeys([...m.members]) }
    : undefined;
};

export interface LxDeps {
  keys: (room: PeopleRoom) => Promise<XidKeys>;
  now: () => number;
}

const post = async (api: PeopleApi, roomId: string, body: FrostBody) => {
  for (const b of await packFrost(body)) {
    await api.send(roomId, b, 'action');
  }
};

export const createLeaderless = (deps: LxDeps) => {
  /**
   * Sign a roster, once: what this device signed for its genesis in this
   * room is kept before the signature leaves, and a different one is refused.
   */
  const signRoster = async (api: PeopleApi, room: PeopleRoom, r: Roster) => {
    const v = viewOf(room);
    const k = await deps.keys(room);
    const id = rosterId(r);
    const here = roomIdOf(room);
    if (!v || !maySignRoster(r, k.pubkey, v.m, undefined)) {
      throw new Error('not everyone in it is in this group');
    }
    let ok = false;
    await api.updateRoom(room.id, x => {
      const s = x.group?.signed?.room === here ? x.group.signed : { room: here };
      ok = maySignRoster(r, k.pubkey, v.m, s.r?.[r.G]);
      return ok ? { ...x, group: { ...x.group!, signed: { ...s, r: { ...s.r, [r.G]: id } } } } : x;
    });
    if (!ok) {
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
    let any = false;
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
      await post(api, room.id, { t: 'join', v: 2, id: h.id, j: h.j, js: h.js, os: signId(me, id) });
      any = true;
    }
    if (any) {
      // the relay keeps two days: a newcomer reads every seat from this, not from the past
      const items = msgs.flatMap(({ body: b }) =>
        b.t === 'i' || (b.t === 'join' && b.os) || b.t === 'rot' || b.t === 'g' || b.t === 'rs'
          ? [b]
          : [],
      );
      if (items.length) {
        await post(api, room.id, {
          t: 'all',
          v: 2,
          id: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
          items,
        });
      }
    }
  };

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
        : b.t === 'rs' && b.id === rot.rot.R
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
      group: { ...x.group!, signed: undefined, next: undefined, told: undefined },
    }));
    await post(api, room.id, {
      t: 'all',
      v: 2,
      id: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
      items: proof,
    });
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

  /** after the fold: what this device can move forward in a leaderless room */
  const act = async (room: PeopleRoom, before: PeopleRoom, api: PeopleApi): Promise<boolean> => {
    const g = room.group;
    if (!g?.g || g.gone) {
      return false;
    }
    const me = await deps.keys(room);
    await cosign(api, room, me);
    const v = viewOf(room)!;
    if (await follow(api, room, v, me)) {
      return true;
    }
    const here = roomIdOf(room);
    const signed = g.signed?.room === here ? g.signed : undefined;
    const r = roomRosterOf(room, v.m);
    if (r && !signed?.r?.[r.G] && v.m.members.has(me.pubkey)) {
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
    const seen = new Set(prior?.rotations.map(x => x.id));
    // a removal someone asked for that waits on this member's word (how it is given is #110's to say)
    for (const x of v.rotations) {
      if (
        !seen.has(x.id) &&
        !x.bound &&
        x.roster.r.members.includes(me.pubkey) &&
        !x.signed.has(me.pubkey)
      ) {
        const out = [...v.m.members].filter(k => !x.roster.r.members.includes(k));
        const by = [...x.signed][0];
        await api.note(room.id, {
          hash: `n:rot:${x.id}`,
          body: `${by ? memberName(by, g.names?.[by]) : 'someone'} asked to remove ${out
            .map(k => memberName(k, g.names?.[k]))
            .join(', ')} · it waits for everyone here`,
          ts: Math.floor(deps.now() / 1000),
        });
      }
    }
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

  /** the group handler around the fold: a room that moved keeps nothing of the old room's pass */
  const handler =
    (fold: typeof foldFrost): RecordHandler =>
    async (room, records, api) => {
      const patch = await fold(room, records);
      if (!room.group?.g || room.group.gone) {
        return patch;
      }
      const moved = await act(patch ? patch(room) : room, room, api);
      return moved ? undefined : patch;
    };

  const groupRoom = async (svc: PeopleService, roomId: string) => {
    const room = await svc.api.room(roomId);
    if (room?.group?.gone) {
      throw new Error("you're no longer in this group");
    }
    if (!room?.group?.g) {
      throw new Error('this group was made with an older zafu');
    }
    return room;
  };

  /**
   * Remove someone before keys: a roster of everyone else, and a rotation to a
   * new room secret sealed to each of them. Both bind when every remaining
   * member signed; this device signs both now.
   */
  const remove = async (svc: PeopleService, where: string, key: string) => {
    const room = await groupRoom(svc, where);
    const v = viewOf(room)!;
    const me = await deps.keys(room);
    if (!v.m.members.has(key) || key === me.pubkey) {
      return { ok: true };
    }
    const g = room.group!;
    const r: Roster = {
      G: genesisId(g.g!),
      members: sortKeys([...v.m.members].filter(k => k !== key)),
    };
    const seals = r.members.filter(k => k !== me.pubkey).map(k => [k, g.seals?.[k]] as const);
    if (seals.some(([, s]) => !s)) {
      throw new Error('not everyone here can be reached yet · please try again in a moment');
    }
    const secret = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const here = roomIdOf(room);
    const rot = { R: rosterId(r), from: here, to: roomId(room.appScope, secret) };
    const id = rotateId(rot);
    let ok = false;
    await svc.api.updateRoom(room.id, x => {
      const s = x.group?.signed?.room === here ? x.group.signed : { room: here };
      ok =
        maySignRoster(r, me.pubkey, v.m, s.r?.[r.G]) &&
        maySignRotate(rot, r, me.pubkey, here, rot.R, s.rot);
      return ok
        ? {
            ...x,
            group: {
              ...x.group!,
              signed: { ...s, r: { ...s.r, [r.G]: rot.R }, rot: id },
              next: { rot: id, secret },
            },
          }
        : x;
    });
    if (!ok) {
      throw new Error('the keys are already being made · removing waits until they are');
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

  return {
    handler,
    ops: {
      /** "agree": this member signs a wallet's roster */
      'lx-agree': async (r: Record<string, unknown>, svc: PeopleService) => {
        const room = await groupRoom(svc, String(r['roomId']));
        const rv = viewOf(room)!.rosters.find(x => x.id === String(r['id']));
        if (!rv) {
          throw new Error('nothing to agree to yet');
        }
        await signRoster(svc.api, room, rv.r);
        void svc.api.sync(room.id).catch(() => undefined);
        return { ok: true };
      },
      /** "make it a shared wallet" (or again, or without someone): a wallet genesis and its roster, signed */
      'lx-wallet': async (r: Record<string, unknown>, svc: PeopleService) => {
        const room = await groupRoom(svc, String(r['roomId']));
        const members = Array.isArray(r['members']) ? r['members'].map(String) : [];
        const k = Number(r['k']);
        const me = await deps.keys(room);
        const G = walletGenesis(members, k, me.pubkey);
        const id = genesisId(G);
        await post(svc.api, room.id, { t: 'g', v: 2, id, g: G });
        await signRoster(svc.api, room, { G: id, members: sortKeys(members) });
        void svc.api.sync(room.id).catch(() => undefined);
        return { id };
      },
      'group-remove': (r: Record<string, unknown>, svc: PeopleService) =>
        remove(svc, `g:${String(r['G'])}`, String(r['key'])),
    },
  };
};
