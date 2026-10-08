/**
 * Groups: make one, open a door into it, come in by the code (groups design
 * 3.2, 3.3, 4.1), with no leader (#110).
 *
 * A group is born with a genesis (what it is for, a shared wallet's t of n)
 * and its creator's seat. Anyone seated invites: each code is one invite,
 * said in the room and answered only by the member who made it, whose device
 * co-signs the one join its door run let in (people/lx). The relay can
 * withhold a join but never forge one.
 *
 * A shared wallet is a group made with a t of n: once n are seated, every
 * member's device signs the roster of all of them, and the keys are made
 * over the room (people/frost-room) once it binds.
 *
 * A group an older zafu made keeps its founder's roster log for reading;
 * it takes no new invites here.
 */

import { channelStateAt, verifyChain } from '@zafu/zirc';
import type { ChannelGenesis, ChannelRecord } from '@zafu/zirc';
import {
  GROUP_ROOM_PLAINTEXT_BYTES,
  ZAFU_GROUP_APP_SCOPE,
  type RoomMessage,
} from '@zafu/zirc/room';
import { bytesToHex } from '@noble/hashes/utils';
import type { XidKeys } from '../state/identity';
import { cleanName, memberName, wordName } from './word-name';
import {
  ANSWERS_PER_CODE,
  DOOR_MS,
  DOOR_SCOPE,
  DOOR_VERSION,
  decodeWire,
  encodeWire,
  makeCode,
  plateSecret,
  splitCode,
  type InviteBody,
} from './door';
import { packFrost } from './frost-room';
import { inviteFor } from './door-run';
import { verify } from './keys';
import { joinMac } from './lx';
import type { Gate, PeopleApi, PeopleService, RecordHandler } from './service';
import { PeopleNeedsRelay } from './service';
import type { DoorHeard, GroupMember, PeopleRoom } from './vault';
import { ed25519 } from '@noble/curves/ed25519';
import { genesisId, inviteId, joinId, sigMessage, type Genesis } from '@zafu/zirc/leaderless';
import { presenceEpoch } from '@zafu/zid';
import { OLD_CODE_RE, groupId, normalizeCode } from './protocol';

export interface GroupDeps {
  walletId: () => Promise<string | undefined>;
  keys: (walletId: string, gen: number, G: string) => Promise<XidKeys>;
  /** the identity generation new rooms are joined under */
  generation: (walletId: string) => Promise<number>;
  /** where new rooms live */
  relay: () => Promise<string>;
  gate: (relay: string) => Promise<Gate>;
  now?: () => number;
}

export { groupId } from './protocol';
/** one code of a group: a group has as many as people it invited */
export const doorId = (G: string, salt: string) => `d:${G}:${salt.slice(0, 8)}`;

/** this device's codes for a group, newest first */
export const doorsOf = (rooms: PeopleRoom[], G: string): PeopleRoom[] =>
  rooms
    .filter(r => r.kind === 'door' && r.door?.role === 'host' && r.signer.G === G)
    .sort((a, b) => b.createdAt - a.createdAt);

/** a code that can still let someone in */
export const doorOpen = (r: PeopleRoom, now: number): boolean =>
  !!r.door && !r.door.admitted && (r.until ?? 0) > now;

/** the door you type a code into says this when its maker needs a newer zafu */
export const OLDER_CODE = 'this code is from an older zafu';
/** a group an older zafu made takes no new invites or removals here */
export const OLDER_GROUP = 'this group was made with an older zafu';

const HEX64 = /^[0-9a-f]{64}$/;

const randomHex = (n: number) => bytesToHex(crypto.getRandomValues(new Uint8Array(n)));

/** a group an older zafu made: the members its founder's log says are in, the founder first */
export const rosterOf = (
  log: { genesis: ChannelGenesis; records: ChannelRecord[] },
  names: Record<string, string> = {},
  at = 0,
): GroupMember[] => {
  const { voice } = channelStateAt(log.genesis.founder, log.records, log.records.length);
  return [...voice]
    .sort((a, b) => (a === log.genesis.founder ? -1 : b === log.genesis.founder ? 1 : 0))
    .map(key => ({ key, name: memberName(key, names[key]), at }));
};

const ensureGate = async (deps: GroupDeps, relay: string) => {
  const gate = await deps.gate(relay);
  if (gate !== 'on') {
    throw new PeopleNeedsRelay(gate);
  }
};

/** k of n, read from a request: undefined for a plain group */
const wantOf = (r: Record<string, unknown>): { k: number; n: number } | undefined => {
  const [k, n] = [Number(r['k']), Number(r['n'])];
  return Number.isInteger(k) && Number.isInteger(n) && k >= 2 && k <= n && n <= 32
    ? { k, n }
    : undefined;
};

const DOOR_KINDS = new Set(['wh', 'wj', 'wa', 'wk', 'wb']);

/** what a door's records add to what it heard: each record once, newest kept */
const heardOf = (room: PeopleRoom, records: RoomMessage[]): DoorHeard[] => {
  const seen = new Set((room.door?.heard ?? []).map(h => `${h.from}:${JSON.stringify(h.wire)}`));
  const fresh = records.flatMap(m => {
    const w = decodeWire(m.body);
    const wire = w && DOOR_KINDS.has(w.kind) ? (w as DoorHeard['wire']) : undefined;
    const key = wire && `${m.author}:${JSON.stringify(wire)}`;
    if (!wire || seen.has(key!)) {
      return [];
    }
    seen.add(key!);
    return [{ from: m.author, at: m.ts, wire }];
  });
  return fresh;
};

export const createGroups = (deps: GroupDeps) => {
  const now = deps.now ?? (() => Date.now());

  const keysFor = (room: Pick<PeopleRoom, 'walletId' | 'signer'>) =>
    deps.keys(room.walletId, room.signer.gen, room.signer.G!);

  const sign = (k: XidKeys, id: string) => bytesToHex(ed25519.sign(sigMessage(id), k.seed));

  /** what a member calls itself here, and the key a new room secret is sealed to */
  const hello = (api: PeopleApi, room: PeopleRoom, k: XidKeys) =>
    api.send(
      room.id,
      encodeWire({
        kind: 'ask',
        key: k.pubkey,
        name: room.nick || wordName(k.pubkey),
        seal: k.xwingPublicKey,
      }),
      'action',
    );

  /**
   * A door this member answers at: a fresh code and salt, open an hour, for
   * one person. Its invite is said in the room, signed by this member.
   */
  const openDoor = async (api: PeopleApi, room: PeopleRoom, at: number) => {
    const k = await keysFor(room);
    const code = makeCode();
    const salt = randomHex(16);
    const door: PeopleRoom = {
      id: doorId(room.group!.G, salt),
      walletId: room.walletId,
      kind: 'door',
      name: room.name,
      appScope: DOOR_SCOPE,
      secret: plateSecret(splitCode(code)!.plate),
      size: GROUP_ROOM_PLAINTEXT_BYTES,
      relay: room.relay,
      signer: room.signer,
      joined: false,
      createdAt: at,
      // a new code is a new mailbox: nothing older to read
      since: presenceEpoch(Math.floor(at / 1000)),
      until: at + DOOR_MS,
      door: {
        code,
        role: 'host',
        owner: k.pubkey,
        salt,
        seed: randomHex(32),
        heard: [],
        answered: [],
      },
    };
    const i = inviteFor(door, room, k.pubkey);
    const id = inviteId(i);
    for (const b of await packFrost({ t: 'i', v: 2, id, i, sig: sign(k, id) })) {
      await api.send(room.id, b, 'action');
    }
    await api.addRoom(door);
    await api.send(door.id, encodeWire({ kind: 'wh', v: DOOR_VERSION, salt }), 'action');
    return code;
  };

  /** doors whose hour ended a day ago are let go */
  const sweep = (api: PeopleApi) =>
    api.rooms().then(async rooms => {
      for (const r of rooms) {
        if (r.kind === 'door' && (r.until ?? 0) < now() - 86_400_000) {
          await api.updateRoom(r.id, () => undefined);
        }
      }
    });

  // -- making one --------------------------------------------------------------

  /**
   * `nick`: what they call you in this group; empty, and your word name is
   * used. `want`: a shared wallet, k of n.
   */
  const create = async (
    svc: PeopleService,
    name: string,
    nick = '',
    want?: { k: number; n: number },
  ) => {
    const walletId = await deps.walletId();
    const group = name.trim().slice(0, 48);
    if (!walletId || !group) {
      throw new Error('a group needs a name');
    }
    const relay = await deps.relay();
    await ensureGate(deps, relay);
    await sweep(svc.api);
    const gen = await deps.generation(walletId);
    const G = randomHex(16);
    const keys = await deps.keys(walletId, gen, G);
    const g: Genesis = want
      ? { purpose: 'wallet', t: want.k, n: want.n, salt: G, creator: keys.pubkey }
      : { purpose: 'chat', t: 0, n: 0, salt: G, creator: keys.pubkey };
    const mine = cleanName(nick);
    const names = { [keys.pubkey]: mine || wordName(keys.pubkey) };
    const at = now();
    const room: PeopleRoom = {
      id: groupId(G),
      walletId,
      kind: 'group',
      name: group,
      ...(mine ? { nick: mine } : {}),
      appScope: ZAFU_GROUP_APP_SCOPE,
      secret: randomHex(32),
      size: GROUP_ROOM_PLAINTEXT_BYTES,
      relay,
      signer: { gen, G },
      joined: true,
      createdAt: at,
      // a group is born here: nothing older to read
      since: presenceEpoch(Math.floor(at / 1000)),
      group: {
        G,
        founder: keys.pubkey,
        mine: true,
        g,
        names,
        seals: { [keys.pubkey]: keys.xwingPublicKey },
        members: [{ key: keys.pubkey, name: names[keys.pubkey]!, at }],
        told: 1,
        ...(want ? { want } : {}),
      },
    };
    await svc.api.addRoom(room);
    await hello(svc.api, room, keys);
    const code = await openDoor(svc.api, room, at);
    return { id: room.id, code };
  };

  /** any member: another code, for another person (the ones before stay open) */
  const renew = async (svc: PeopleService, G: string) => {
    const room = await svc.api.room(groupId(G));
    if (!room?.group?.g || room.group.gone) {
      throw new Error(OLDER_GROUP);
    }
    await ensureGate(deps, room.relay);
    return { code: await openDoor(svc.api, room, now()) };
  };

  /** the inviter answered one run: its record in the mailbox, and the run's words kept */
  const answer = async (svc: PeopleService, r: Record<string, unknown>) => {
    const door = await svc.api.room(String(r['roomId']));
    const d = door?.door;
    const jid = String(r['jid']);
    const wire = {
      kind: 'wa' as const,
      v: DOOR_VERSION,
      salt: String(r['salt']),
      jid,
      x: String(r['x']),
      tag: String(r['tag']),
    };
    if (
      !door ||
      d?.role !== 'host' ||
      !doorOpen(door, now()) ||
      decodeWire(encodeWire(wire))?.kind !== 'wa' ||
      wire.salt !== d.salt ||
      (d.answered ?? []).some(a => a.jid === jid) ||
      (d.answered ?? []).length >= ANSWERS_PER_CODE
    ) {
      throw new Error('this door does not answer that');
    }
    const words = String(r['words'] ?? '').slice(0, 40);
    await svc.api.send(door.id, encodeWire(wire), 'action');
    await svc.api.updateRoom(door.id, x => ({
      ...x,
      door: {
        ...x.door!,
        answered: [...(x.door!.answered ?? []), { jid, words, at: now(), x: wire.x }],
      },
    }));
    return { ok: true };
  };

  /**
   * The inviter: the invite, to the one run whose words held. The code is
   * spent, and the run is kept: its transcript, and its key, which proves
   * the join that comes through it.
   */
  const admit = async (svc: PeopleService, r: Record<string, unknown>) => {
    const jid = String(r['jid']);
    const door = await svc.api.room(String(r['roomId']));
    const d = door?.door;
    const th = String(r['th']);
    const mk = String(r['mk']);
    const wire = {
      kind: 'wb' as const,
      v: DOOR_VERSION,
      salt: d?.salt ?? '',
      jid,
      box: String(r['box']),
    };
    if (
      !door ||
      d?.role !== 'host' ||
      !doorOpen(door, now()) ||
      !(d.answered ?? []).some(a => a.jid === jid) ||
      !HEX64.test(th) ||
      !HEX64.test(mk) ||
      decodeWire(encodeWire(wire))?.kind !== 'wb'
    ) {
      throw new Error('this door does not answer that');
    }
    // spent before the box leaves, so two windows answering at once send one box
    let won = false;
    await svc.api.updateRoom(door.id, x => {
      won = !x.door?.admitted;
      return won ? { ...x, door: { ...x.door!, admitted: jid, th, mk } } : x;
    });
    if (!won) {
      throw new Error('this code already let someone in');
    }
    try {
      await svc.api.send(door.id, encodeWire(wire), 'action');
    } catch (e) {
      // the box did not leave: the code is open again for this run's next try
      await svc.api.updateRoom(door.id, x =>
        x.door?.admitted === jid
          ? { ...x, door: { ...x.door, admitted: undefined, th: undefined, mk: undefined } }
          : x,
      );
      throw e;
    }
    return { ok: true };
  };

  // -- the joiner ------------------------------------------------------------

  /**
   * a code typed in: its mailbox, read back over the door's hour. The same
   * code again finds the door already open. Nothing is said yet: the
   * screen's SPAKE2 step speaks once it has read the inviter's hello.
   */
  const open = async (svc: PeopleService, raw: string, nick = '') => {
    const code = normalizeCode(raw);
    if (OLD_CODE_RE.test(code)) {
      throw new Error(OLDER_CODE);
    }
    const plate = splitCode(code)?.plate;
    const walletId = await deps.walletId();
    if (!plate || !walletId) {
      throw new Error("zafu couldn't read this code");
    }
    const relay = await deps.relay();
    await ensureGate(deps, relay);
    await sweep(svc.api);
    const at = now();
    const was = (await svc.api.rooms()).find(
      x =>
        x.kind === 'door' &&
        x.door?.role === 'join' &&
        x.door.code === code &&
        !x.door.wrong &&
        (x.until ?? 0) > at,
    );
    if (was) {
      void svc.api.sync(was.id).catch(() => undefined);
      return { id: was.id };
    }
    const jid = randomHex(8);
    const mine = cleanName(nick);
    const door: PeopleRoom = {
      id: `d:${jid}`,
      walletId,
      kind: 'door',
      name: code,
      ...(mine ? { nick: mine } : {}),
      appScope: DOOR_SCOPE,
      secret: plateSecret(plate),
      size: GROUP_ROOM_PLAINTEXT_BYTES,
      relay,
      // a key for this door alone: nothing it signs links to the group or to you
      signer: { gen: await deps.generation(walletId), G: randomHex(16) },
      joined: false,
      createdAt: at,
      // the inviter's hello can be up to an hour old
      since: presenceEpoch(Math.floor((at - DOOR_MS) / 1000)),
      until: at + DOOR_MS,
      door: { code, role: 'join', jid, seed: randomHex(32), sent: [], heard: [] },
    };
    await svc.api.addRoom(door);
    await svc.api.sync(door.id);
    return { id: door.id };
  };

  /** a joiner speaks to one inviter's hello */
  const join = async (svc: PeopleService, r: Record<string, unknown>) => {
    const door = await svc.api.room(String(r['roomId']));
    const d = door?.door;
    const wire = {
      kind: 'wj' as const,
      v: DOOR_VERSION,
      salt: String(r['salt']),
      jid: d?.jid ?? '',
      y: String(r['y']),
    };
    if (!door || d?.role !== 'join' || decodeWire(encodeWire(wire))?.kind !== 'wj') {
      throw new Error('this door does not say that');
    }
    await svc.api.send(door.id, encodeWire(wire), 'action');
    await svc.api.updateRoom(door.id, x => ({
      ...x,
      door: { ...x.door!, sent: [...new Set([...(x.door!.sent ?? []), wire.salt])] },
    }));
    return { ok: true };
  };

  /** a joiner: the inviter's tag held, so its own goes back */
  const confirm = async (svc: PeopleService, r: Record<string, unknown>) => {
    const door = await svc.api.room(String(r['roomId']));
    const d = door?.door;
    const wire = {
      kind: 'wk' as const,
      v: DOOR_VERSION,
      salt: String(r['salt']),
      jid: d?.jid ?? '',
      tag: String(r['tag']),
    };
    if (!door || d?.role !== 'join' || decodeWire(encodeWire(wire))?.kind !== 'wk') {
      throw new Error('this door does not say that');
    }
    await svc.api.send(door.id, encodeWire(wire), 'action');
    await svc.api.updateRoom(door.id, x => ({
      ...x,
      door: { ...x.door!, confirmed: [...new Set([...(x.door!.confirmed ?? []), wire.salt])] },
    }));
    return { ok: true };
  };

  /**
   * The box opened: the group joins this wallet, and this member says its
   * half of the join, proved to the inviter with the run's key. Typing the
   * code was the yes: nothing more is asked, here or for a shared wallet's
   * roster (people/lx signs it once everyone is in).
   */
  const enter = async (svc: PeopleService, r: Record<string, unknown>) => {
    const door = await svc.api.room(String(r['roomId']));
    const invite = r['invite'] as InviteBody | undefined;
    const walletId = await deps.walletId();
    const th = String(r['th']);
    const mk = String(r['mk']);
    let I: string | undefined;
    try {
      I = invite && inviteId(invite.I);
      if (invite && (genesisId(invite.g) !== invite.I.G || invite.g.salt !== invite.G)) {
        I = undefined;
      }
    } catch {
      I = undefined;
    }
    if (
      !door?.door ||
      door.door.role !== 'join' ||
      !walletId ||
      !invite ||
      !I ||
      !HEX64.test(invite.secret ?? '') ||
      !HEX64.test(th) ||
      !HEX64.test(mk) ||
      typeof invite.relay !== 'string'
    ) {
      throw new Error('not an invite');
    }
    const { G, g } = invite;
    const words = String(r['words'] ?? '').slice(0, 40);
    const was = await svc.api.room(groupId(G));
    const stay = was?.joined && !was.group?.gone;
    const gen = stay ? was.signer.gen : await deps.generation(walletId);
    const keys = await deps.keys(walletId, gen, G);
    // someone taken off and invited again comes into the room as it is now
    if (!stay) {
      await svc.api.addRoom({
        id: groupId(G),
        walletId,
        kind: 'group',
        name: invite.group || 'a group',
        ...(door.nick ? { nick: door.nick } : {}),
        appScope: ZAFU_GROUP_APP_SCOPE,
        secret: invite.secret,
        size: GROUP_ROOM_PLAINTEXT_BYTES,
        relay: invite.relay,
        signer: { gen, G },
        joined: true,
        createdAt: now(),
        // from the window the group was made in, not the relay's 48 h
        ...(invite.born !== undefined ? { since: invite.born } : {}),
        group: {
          G,
          founder: g.creator,
          mine: false,
          g,
          members: [],
          names: { [invite.I.owner]: cleanName(invite.from) },
          ...(g.purpose === 'wallet' ? { want: { k: g.t, n: g.n } } : {}),
        },
      });
    }
    const room = (await svc.api.room(groupId(G)))!;
    await hello(svc.api, room, keys);
    const j = { I, joiner: keys.pubkey, th };
    const id = joinId(j);
    for (const b of await packFrost({
      t: 'join',
      v: 2,
      id: I,
      j,
      js: sign(keys, id),
      jm: joinMac(mk, id),
    })) {
      await svc.api.send(room.id, b, 'action');
    }
    await svc.api.note(room.id, {
      hash: `n:door:${door.door.jid}`,
      body: `you came in with the code · words to compare: ${words}`,
      ts: Math.floor(now() / 1000),
    });
    void svc.api.sync(room.id).catch(() => undefined);
    await svc.api.updateRoom(door.id, x => ({
      ...x,
      until: now(),
      door: { ...x.door!, G, words },
    }));
    return { G };
  };

  /** every answer said the words differ, or (`used`) the code let someone else in */
  const ended = (svc: PeopleService, r: Record<string, unknown>, why: 'wrong' | 'used') =>
    svc.api.updateRoom(String(r['roomId']), x =>
      x.door?.role === 'join' ? { ...x, until: now(), door: { ...x.door, [why]: true } } : x,
    );

  // -- what a pass does with the records it found ----------------------------

  const onDoor: RecordHandler = async (room, records) => {
    const fresh = room.door ? heardOf(room, records) : [];
    return fresh.length
      ? r => ({ ...r, door: { ...r.door!, heard: [...r.door!.heard, ...fresh].slice(-200) } })
      : undefined;
  };

  /**
   * What members say about themselves (a hello: their name and seal key),
   * and, in a group an older zafu made, its founder's roster log and names.
   */
  const onGroup: RecordHandler = async (room, records) => {
    const g = room.group;
    if (!g) {
      return undefined;
    }
    const wires = records
      .map(m => ({ m, w: decodeWire(m.body) }))
      .filter((x): x is { m: RoomMessage; w: NonNullable<typeof x.w> } => !!x.w)
      .sort((a, b) => a.m.ts - b.m.ts);
    const said: Record<string, string> = {};
    const seals: Record<string, string> = {};
    for (const { m, w } of wires) {
      if (w.kind === 'ask' && w.key === m.author) {
        said[w.key] = cleanName(w.name);
        seals[w.key] = w.seal;
      }
    }
    let log = g.log;
    let heard: Record<string, string> | undefined;
    if (!g.g) {
      // the log arrives as entries: genesis, then records by index
      const entries = wires.flatMap(({ w }) => (w.kind === 'log' ? [w.entry] : []));
      const genesis =
        (entries.find(e => !('at' in e)) as ChannelGenesis | undefined) ?? log?.genesis;
      if (genesis && genesis.id === g.G && genesis.founder === g.founder) {
        const byAt = new Map<number, ChannelRecord>();
        for (const r of [...(log?.records ?? []), ...entries.filter(e => 'at' in e)]) {
          byAt.set(r.at, r);
        }
        const records = [...byAt.values()].sort((a, b) => a.at - b.at);
        // the longest prefix that verifies from genesis; a forged tail is dropped
        for (let n = records.length; n >= 0; n--) {
          const head = records.slice(0, n);
          if ((await verifyChain({ genesis, records: head, signer: { verify } })).ok) {
            if (head.length >= (log?.records.length ?? 0)) {
              log = { genesis, records: head };
            }
            break;
          }
        }
      }
      for (const { m, w } of wires) {
        if (w.kind === 'names' && m.author === g.founder) {
          heard = {
            ...heard,
            ...Object.fromEntries(
              Object.entries(w.names).map(([k, v]) => [k, cleanName(String(v))]),
            ),
          };
        }
      }
    }
    if (log === g.log && !heard && !Object.keys(said).length) {
      return undefined;
    }
    // applied to the room as it is NOW. A legacy log only grows, so the longer
    // verified one is the newer; a member's own hello names them.
    return r => {
      const cur = r.group!;
      const next = (cur.log?.records.length ?? -1) >= (log?.records.length ?? -1) ? cur.log : log;
      const names = { ...cur.names, ...heard, ...said };
      return {
        ...r,
        group: {
          ...cur,
          log: next,
          names,
          seals: { ...cur.seals, ...seals },
          members:
            !cur.g && next
              ? rosterOf(next, names, room.createdAt)
              : cur.members.map(x => ({
                  ...x,
                  name: memberName(x.key, names[x.key]),
                  ...(seals[x.key] || cur.seals?.[x.key]
                    ? { sealKey: seals[x.key] ?? cur.seals![x.key] }
                    : {}),
                })),
        },
      };
    };
  };

  return {
    ops: {
      'group-create': (r: Record<string, unknown>, s: PeopleService) =>
        create(s, String(r['name'] ?? ''), String(r['nick'] ?? ''), wantOf(r)),
      'group-renew': (r: Record<string, unknown>, s: PeopleService) => renew(s, String(r['G'])),
      'door-open': (r: Record<string, unknown>, s: PeopleService) =>
        open(s, String(r['code'] ?? ''), String(r['nick'] ?? '')),
      'door-join': (r: Record<string, unknown>, s: PeopleService) => join(s, r),
      'door-answer': (r: Record<string, unknown>, s: PeopleService) => answer(s, r),
      'door-enter': (r: Record<string, unknown>, s: PeopleService) => enter(s, r),
      'door-confirm': (r: Record<string, unknown>, s: PeopleService) => confirm(s, r),
      'door-admit': (r: Record<string, unknown>, s: PeopleService) => admit(s, r),
      'door-wrong': (r: Record<string, unknown>, s: PeopleService) => ended(s, r, 'wrong'),
      'door-used': (r: Record<string, unknown>, s: PeopleService) => ended(s, r, 'used'),
    },
    handlers: { door: onDoor, group: onGroup },
  };
};
