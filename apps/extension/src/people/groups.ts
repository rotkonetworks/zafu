/**
 * Groups: make one, open its door, come in by the code, and read the roster
 * from the founder's log (groups design 3.2, 3.3, 4.1).
 *
 * Membership lives on a zirc channel log the founder writes and posts into
 * the group room: genesis, `+v` founder, `+v` each person who came in. Every
 * member verifies it from genesis, so the relay can withhold a roster update
 * but never forge one. Only someone who holds the room secret can ask in the
 * room, and the secret only leaves inside a door run (people/door) or a memo
 * invite, so the founder's device voices every ask it reads there.
 *
 * A shared wallet is a group made with a k of n: once n are on the roster,
 * the founder's device says the start of its keys in the room (people/
 * frost-room), and every member's device makes its share as it comes by.
 */

import {
  appendRecord,
  channelStateAt,
  createGenesis,
  verifyChain,
  DEFAULT_RULES,
} from '@zafu/zirc';
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
import { packFrost, startBody, type Deal } from './frost-room';
import { identityOf, verify } from './keys';
import type { Gate, PeopleApi, PeopleService, RecordHandler } from './service';
import { PeopleNeedsRelay } from './service';
import type { DoorHeard, GroupMember, PeopleRoom } from './vault';
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

/** the founder's codes for a group, newest first */
export const doorsOf = (rooms: PeopleRoom[], G: string): PeopleRoom[] =>
  rooms
    .filter(r => r.kind === 'door' && r.door?.role === 'host' && r.signer.G === G)
    .sort((a, b) => b.createdAt - a.createdAt);

/** a code that can still let someone in */
export const doorOpen = (r: PeopleRoom, now: number): boolean =>
  !!r.door && !r.door.admitted && (r.until ?? 0) > now;

/** the door you type a code into says this when its maker needs a newer zafu */
export const OLDER_CODE = 'this code is from an older zafu';

const randomHex = (n: number) => bytesToHex(crypto.getRandomValues(new Uint8Array(n)));

/** the members a log says are in: voiced, the founder first */
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

  /** post the whole log and the names into the group room, so a new member reads them */
  const postRoster = async (api: PeopleApi, room: PeopleRoom) => {
    const g = room.group!;
    if (!g.log) {
      return;
    }
    for (const entry of [g.log.genesis, ...g.log.records]) {
      await api.send(room.id, encodeWire({ kind: 'log', entry }), 'action');
    }
    await api.send(room.id, encodeWire({ kind: 'names', names: g.names ?? {} }), 'action');
  };

  /** a door this group answers at: a fresh code and salt, open an hour, for one person */
  const openDoor = async (api: PeopleApi, room: PeopleRoom, at: number) => {
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
      door: { code, role: 'host', salt, seed: randomHex(32), heard: [], answered: [] },
    };
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

  // -- the founder ---------------------------------------------------------

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
    const me = identityOf(keys);
    const genesis = await createGenesis({ id: G, founder: me, rules: DEFAULT_RULES });
    const records = [
      await appendRecord({
        genesis,
        records: [],
        author: me,
        body: { kind: 'mode', mode: '+v', subject: me.pubkey },
      }),
    ];
    const mine = cleanName(nick);
    const names = { [me.pubkey]: mine || me.name! };
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
        founder: me.pubkey,
        mine: true,
        log: { genesis, records },
        names,
        members: rosterOf({ genesis, records }, names, at),
        ...(want ? { want } : {}),
      },
    };
    await svc.api.addRoom(room);
    const code = await openDoor(svc.api, room, at);
    await postRoster(svc.api, room);
    return { id: room.id, code };
  };

  /** the founder: another code, for another person (the ones before stay open) */
  const renew = async (svc: PeopleService, G: string) => {
    const room = await svc.api.room(groupId(G));
    if (!room?.group?.mine) {
      throw new Error('only the founder can invite');
    }
    await ensureGate(deps, room.relay);
    return { code: await openDoor(svc.api, room, now()) };
  };

  /** the founder answered one run: its record in the mailbox, and the run's words kept */
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
      door: { ...x.door!, answered: [...(x.door!.answered ?? []), { jid, words, at: now() }] },
    }));
    return { ok: true };
  };

  /** the founder: the invite, to the one run whose words held. The code is spent. */
  const admit = async (svc: PeopleService, r: Record<string, unknown>) => {
    const jid = String(r['jid']);
    const door = await svc.api.room(String(r['roomId']));
    const d = door?.door;
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
      decodeWire(encodeWire(wire))?.kind !== 'wb'
    ) {
      throw new Error('this door does not answer that');
    }
    // spent before the box leaves, so two windows answering at once send one box
    let won = false;
    await svc.api.updateRoom(door.id, x => {
      won = !x.door?.admitted;
      return won ? { ...x, door: { ...x.door!, admitted: jid } } : x;
    });
    if (!won) {
      throw new Error('this code already let someone in');
    }
    try {
      await svc.api.send(door.id, encodeWire(wire), 'action');
    } catch (e) {
      // the box did not leave: the code is open again for this run's next try
      await svc.api.updateRoom(door.id, x =>
        x.door?.admitted === jid ? { ...x, door: { ...x.door, admitted: undefined } } : x,
      );
      throw e;
    }
    return { ok: true };
  };

  // -- the joiner ------------------------------------------------------------

  /**
   * a code typed in: its mailbox, read back over the door's hour. The same
   * code again finds the door already open. Nothing is said yet: the
   * screen's SPAKE2 step speaks once it has read the founder's hello.
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
      // the founder's hello can be up to an hour old
      since: presenceEpoch(Math.floor((at - DOOR_MS) / 1000)),
      until: at + DOOR_MS,
      door: { code, role: 'join', jid, seed: randomHex(32), sent: [], heard: [] },
    };
    await svc.api.addRoom(door);
    await svc.api.sync(door.id);
    return { id: door.id };
  };

  /** a joiner speaks to one founder's hello */
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

  /** a joiner: the founder's tag held, so its own goes back */
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

  /** the answer opened: the group joins this wallet, and an ask puts you on its roster */
  const enter = async (svc: PeopleService, r: Record<string, unknown>) => {
    const door = await svc.api.room(String(r['roomId']));
    const invite = r['invite'] as InviteBody | undefined;
    const walletId = await deps.walletId();
    if (
      !door?.door ||
      door.door.role !== 'join' ||
      !walletId ||
      !/^[0-9a-f]{64}$/.test(invite?.secret ?? '') ||
      !/^[0-9a-f]{32}$/.test(invite?.G ?? '') ||
      !/^[0-9a-f]{64}$/.test(invite?.founder ?? '') ||
      typeof invite?.relay !== 'string'
    ) {
      throw new Error('not an invite');
    }
    const { G } = invite;
    const words = String(r['words'] ?? '').slice(0, 40);
    const want = wantOf({ ...invite.want });
    const was = await svc.api.room(groupId(G));
    const gen = was?.joined ? was.signer.gen : await deps.generation(walletId);
    const keys = await deps.keys(walletId, gen, G);
    // someone taken off and invited again keeps their room, and asks again
    if (!was?.joined) {
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
        // from the window the group was made in, not the relay's whole 48 h
        ...(invite.born !== undefined ? { since: invite.born } : {}),
        group: {
          G,
          founder: invite.founder,
          mine: false,
          members: [],
          names: { [invite.founder]: cleanName(invite.from) },
          ...(want ? { want } : {}),
        },
      });
    }
    await svc.api.send(
      groupId(G),
      encodeWire({
        kind: 'ask',
        key: keys.pubkey,
        name: door.nick || wordName(keys.pubkey),
        seal: keys.xwingPublicKey,
        ...(door.door.jid ? { t: door.door.jid } : {}),
      }),
      'action',
    );
    await svc.api.note(groupId(G), {
      hash: `n:door:${door.door.jid}`,
      body: `you came in with the code · words to compare: ${words}`,
      ts: Math.floor(now() / 1000),
    });
    void svc.api.sync(groupId(G)).catch(() => undefined);
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

  /** The founder: everyone who asks in the room itself goes on the roster. */
  const voiceAsks = async (
    room: PeopleRoom,
    records: RoomMessage[],
    api: PeopleApi,
  ): Promise<PeopleRoom | undefined> => {
    const g = room.group;
    if (!g?.mine || !g.log) {
      return undefined;
    }
    const roster = new Set(rosterOf(g.log).map(m => m.key));
    // the codes that let someone in, and whether that someone came yet
    const doors = (await api.rooms()).filter(
      r => r.kind === 'door' && r.signer.G === g.G && r.door?.admitted,
    );
    const fresh = (t?: string) => doors.find(d => d.door!.admitted === t && !d.door!.came);
    // someone the founder took off stays off, unless a new code let them in again
    const removed = new Set(
      g.log.records.flatMap(r =>
        r.body.kind === 'mode' && r.body.mode === '-v' ? [r.body.subject] : [],
      ),
    );
    const asks = records.flatMap(m => {
      const w = decodeWire(m.body);
      return w?.kind === 'ask' &&
        w.key === m.author &&
        !roster.has(w.key) &&
        (!removed.has(w.key) || fresh(w.t))
        ? [w]
        : [];
    });
    if (!asks.length) {
      return undefined;
    }
    const me = identityOf(await keysFor(room));
    let { records: log } = g.log;
    const names = { ...g.names };
    for (const a of asks) {
      if (roster.has(a.key)) {
        continue;
      }
      log = [
        ...log,
        await appendRecord({
          genesis: g.log.genesis,
          records: log,
          author: me,
          body: { kind: 'mode', mode: '+v', subject: a.key },
        }),
      ];
      names[a.key] = memberName(a.key, a.name);
      roster.add(a.key);
    }
    const next = await api.updateRoom(room.id, r => ({
      ...r,
      group: {
        ...r.group!,
        log: { genesis: g.log!.genesis, records: log },
        names,
        members: rosterOf({ genesis: g.log!.genesis, records: log }, names, r.createdAt),
      },
    }));
    if (next) {
      await postRoster(api, next);
      // each arrival, said in the founder's thread with the code's words to compare
      for (const a of asks) {
        const door = fresh(a.t);
        const words = door?.door!.answered?.find(r => r.jid === a.t)?.words;
        if (door) {
          await api.updateRoom(door.id, r => ({ ...r, door: { ...r.door!, came: a.key } }));
        }
        await api.note(room.id, {
          hash: `n:join:${a.key}`,
          body: `${names[a.key]} joined${words ? ` with your code · words to compare: ${words}` : ''}`,
          ts: Math.floor(now() / 1000),
        });
      }
    }
    return next;
  };

  /**
   * The founder takes someone off the roster, until the keys of a shared
   * wallet are being made (after that, its card can start again without them).
   */
  const remove = async (svc: PeopleService, G: string, key: string) => {
    const room = await svc.api.room(groupId(G));
    const g = room?.group;
    if (!g?.mine || !g.log || g.want?.started || key === g.founder) {
      throw new Error('only the founder can do that, before the keys are made');
    }
    if (!rosterOf(g.log).some(m => m.key === key)) {
      return { ok: true };
    }
    const me = identityOf(await keysFor(room!));
    const records = [
      ...g.log.records,
      await appendRecord({
        genesis: g.log.genesis,
        records: g.log.records,
        author: me,
        body: { kind: 'mode', mode: '-v', subject: key },
      }),
    ];
    const next = await svc.api.updateRoom(room!.id, r => ({
      ...r,
      group: {
        ...r.group!,
        log: { genesis: g.log!.genesis, records },
        members: rosterOf({ genesis: g.log!.genesis, records }, r.group!.names, r.createdAt),
      },
    }));
    if (next) {
      await postRoster(svc.api, next);
      await svc.api.note(next.id, {
        hash: `n:left:${key}:${records.length}`,
        body: `${memberName(key, g.names?.[key])} is no longer in the group`,
        ts: Math.floor(now() / 1000),
      });
    }
    return { ok: true };
  };

  /**
   * The founder of a shared wallet: once n are on the roster, the start of
   * its keys, said once. The first n members make it; a later ask still
   * joins the chat.
   */
  const startWhenFull = async (room: PeopleRoom, api: PeopleApi, deal?: Deal) => {
    const g = room.group;
    const want = g?.want;
    if (!g?.mine || !want || want.started || g.members.length < want.n) {
      return;
    }
    const body = startBody(
      g.members.slice(0, want.n).map(m => m.key),
      want.k,
      room.name,
      deal ? { deal } : {},
    );
    // a room is read by one pass at a time, so said, then marked, is said once
    for (const b of await packFrost(body)) {
      await api.send(room.id, b, 'action');
    }
    await api.updateRoom(room.id, r => ({
      ...r,
      group: { ...r.group!, want: { ...r.group!.want!, started: body.id } },
    }));
  };

  const onGroup: RecordHandler = async (seen, records, api) => {
    // the room as it stands after any new member went on the roster
    const room = (await voiceAsks(seen, records, api)) ?? seen;
    await startWhenFull(room, api, room.group?.deal);
    const g = room.group;
    if (!g) {
      return undefined;
    }
    let log = g.log;
    const wires = records
      .map(m => ({ m, w: decodeWire(m.body) }))
      .filter((x): x is { m: RoomMessage; w: NonNullable<typeof x.w> } => !!x.w)
      .sort((a, b) => a.m.ts - b.m.ts);
    // the log arrives as entries: genesis, then records by index
    const entries = wires.flatMap(({ w }) => (w.kind === 'log' ? [w.entry] : []));
    const genesis = (entries.find(e => !('at' in e)) as ChannelGenesis | undefined) ?? log?.genesis;
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
    let heard: Record<string, string> | undefined;
    for (const { m, w } of wires) {
      if (w.kind === 'names' && m.author === g.founder) {
        heard = {
          ...heard,
          ...Object.fromEntries(Object.entries(w.names).map(([k, v]) => [k, cleanName(String(v))])),
        };
      }
    }
    if (log === g.log && !heard) {
      return undefined;
    }
    // applied to the room as it is NOW: an ask may have been voiced while this
    // pass read the relay, and a stale roster must never undo it. The log only
    // grows, so the longer verified one is the newer; the founder's own names
    // are theirs, a member takes the founder's latest word.
    return r => {
      const cur = r.group!;
      const next = (cur.log?.records.length ?? -1) >= (log?.records.length ?? -1) ? cur.log : log;
      const all = g.mine ? { ...heard, ...cur.names } : { ...cur.names, ...heard };
      return {
        ...r,
        group: {
          ...cur,
          log: next,
          names: all,
          members: next ? rosterOf(next, all, room.createdAt) : cur.members,
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
      'group-remove': (r: Record<string, unknown>, s: PeopleService) =>
        remove(s, String(r['G']), String(r['key'])),
    },
    handlers: { door: onDoor, group: onGroup },
  };
};
