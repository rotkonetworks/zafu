/**
 * Groups, chat only: make one, open its door, ask to join, allow, and read
 * the roster from the founder's log (groups design 3.2, 3.3, 4.1).
 *
 * Membership lives on a zirc channel log the founder writes and posts into
 * the group room: genesis, `+v` founder, `+v` each person they allowed. Every
 * member verifies it from genesis, so the relay can withhold a roster update
 * but never forge one. Proposals, seals and the DKG are not here yet.
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
  Room,
  ZAFU_GROUP_APP_SCOPE,
  type RoomMessage,
} from '@zafu/zirc/room';
import { bytesToHex } from '@noble/hashes/utils';
import { shortXid, xidOf, type XidKeys } from '../state/identity';
import {
  CODE_RE,
  DOOR_MS,
  DOOR_SCOPE,
  decodeWire,
  doorSecret,
  encodeWire,
  makeCode,
  normalizeCode,
  openInviteBody,
  sealInviteBody,
} from './door';
import { ephemeralIdentity, identityOf, verify } from './keys';
import type { Gate, PeopleApi, PeopleService, RecordHandler } from './service';
import { PeopleNeedsRelay } from './service';
import type { GroupMember, PeopleRoom } from './vault';
import type { RelayTransport } from '@zafu/zid';

export interface GroupDeps {
  walletId: () => Promise<string | undefined>;
  keys: (walletId: string, gen: number, G: string) => Promise<XidKeys>;
  /** the identity generation new rooms are joined under */
  generation: (walletId: string) => Promise<number>;
  /** where new rooms live */
  relay: () => Promise<string>;
  gate: (relay: string) => Promise<Gate>;
  transport: (relay: string, size: number, signal: AbortSignal) => RelayTransport;
  now?: () => number;
}

export const groupId = (G: string) => `g:${G}`;
export const doorId = (G: string) => `d:${G}`;

/** what a code opens, before anyone asks to join */
export interface DoorCard {
  G: string;
  group: string;
  from: string;
  count: number;
  founder: string;
}

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
    .map(key => ({ key, name: names[key] ?? shortXid(xidOf(key)), at }));
};

const ensureGate = async (deps: GroupDeps, relay: string) => {
  const gate = await deps.gate(relay);
  if (gate !== 'on') {
    throw new PeopleNeedsRelay(gate);
  }
};

export const createGroups = (deps: GroupDeps) => {
  const now = deps.now ?? (() => Date.now());
  const peeks = new Map<string, DoorCard>();

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

  // -- the founder ---------------------------------------------------------

  const create = async (svc: PeopleService, name: string) => {
    const walletId = await deps.walletId();
    const group = name.trim().slice(0, 48);
    if (!walletId || !group) {
      throw new Error('a group needs a name');
    }
    const relay = await deps.relay();
    await ensureGate(deps, relay);
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
    const names = { [me.pubkey]: me.name! };
    const code = makeCode();
    const at = now();
    const base = {
      walletId,
      relay,
      size: GROUP_ROOM_PLAINTEXT_BYTES,
      signer: { gen, G },
      createdAt: at,
    };
    const room: PeopleRoom = {
      ...base,
      id: groupId(G),
      kind: 'group',
      name: group,
      appScope: ZAFU_GROUP_APP_SCOPE,
      secret: randomHex(32),
      joined: true,
      group: {
        G,
        founder: me.pubkey,
        mine: true,
        log: { genesis, records },
        names,
        members: rosterOf({ genesis, records }, names, at),
      },
    };
    const door = openDoor(room, code, at);
    await svc.api.addRoom(room);
    await svc.api.addRoom(door);
    await postRoster(svc.api, room);
    await postCard(svc.api, door, room);
    return { id: room.id, code };
  };

  const openDoor = (room: PeopleRoom, code: string, at: number): PeopleRoom => ({
    id: doorId(room.group!.G),
    walletId: room.walletId,
    kind: 'door',
    name: room.name,
    appScope: DOOR_SCOPE,
    secret: bytesToHex(doorSecret(code)),
    size: GROUP_ROOM_PLAINTEXT_BYTES,
    relay: room.relay,
    signer: room.signer,
    joined: false,
    createdAt: at,
    until: at + DOOR_MS,
    group: { ...room.group!, code, requests: [], log: undefined, names: undefined },
  });

  const postCard = (api: PeopleApi, door: PeopleRoom, room: PeopleRoom) => {
    const g = room.group!;
    return api.send(
      door.id,
      encodeWire({
        kind: 'card',
        G: g.G,
        founder: g.founder,
        group: room.name,
        from: g.names?.[g.founder] ?? shortXid(xidOf(g.founder)),
        count: g.members.length,
      }),
      'action',
    );
  };

  /** the founder lets one person in: +v on the log, the secret sealed to them */
  const allow = async (svc: PeopleService, G: string, key: string) => {
    const rooms = await svc.api.room(groupId(G));
    const door = await svc.api.room(doorId(G));
    const ask = door?.group?.requests?.find(r => r.key === key);
    if (!rooms || !door || !ask || !rooms.group?.mine || !rooms.group.log) {
      throw new Error('nobody is asking');
    }
    const me = identityOf(await keysFor(rooms));
    const { genesis, records } = rooms.group.log;
    const voiced = rosterOf(rooms.group.log).some(m => m.key === key);
    const next = voiced
      ? records
      : [
          ...records,
          await appendRecord({
            genesis,
            records,
            author: me,
            body: { kind: 'mode', mode: '+v', subject: key },
          }),
        ];
    const names = { ...rooms.group.names, [key]: ask.name };
    const at = now();
    const room = await svc.api.updateRoom(groupId(G), r => ({
      ...r,
      group: {
        ...r.group!,
        log: { genesis, records: next },
        names,
        members: rosterOf({ genesis, records: next }, names, at),
      },
    }));
    await svc.api.send(
      doorId(G),
      encodeWire({
        kind: 'invite',
        to: key,
        sealed: sealInviteBody(ask.sealKey, {
          secret: rooms.secret,
          relay: rooms.relay,
          group: rooms.name,
        }),
      }),
      'action',
    );
    await svc.api.updateRoom(doorId(G), r => ({
      ...r,
      group: { ...r.group!, requests: r.group!.requests?.filter(q => q.key !== key) },
    }));
    if (room) {
      await postRoster(svc.api, room);
    }
  };

  /** the founder: a fresh code when the hour is up */
  const renew = async (svc: PeopleService, G: string) => {
    const room = await svc.api.room(groupId(G));
    if (!room?.group?.mine) {
      throw new Error('only the founder can invite');
    }
    await ensureGate(deps, room.relay);
    const code = makeCode();
    const door = openDoor(room, code, now());
    await svc.api.addRoom(door);
    await postCard(svc.api, door, room);
    return { code };
  };

  /** the founder: not this person (their ask is not shown again) */
  const decline = (svc: PeopleService, G: string, key: string) =>
    svc.api.updateRoom(doorId(G), r => ({
      ...r,
      group: {
        ...r.group!,
        requests: r.group!.requests?.filter(q => q.key !== key),
        declined: [...(r.group!.declined ?? []), key],
      },
    }));

  // -- the joiner ------------------------------------------------------------

  /** read a door: who invites you, to what. Nothing is written. */
  const peek = async (svc: PeopleService, raw: string): Promise<DoorCard | null> => {
    const code = normalizeCode(raw);
    if (!CODE_RE.test(code)) {
      throw new Error('this code cannot be read');
    }
    const relay = await deps.relay();
    await ensureGate(deps, relay);
    const room = new Room(ephemeralIdentity(), {
      appScope: DOOR_SCOPE,
      channel: '#zafu',
      roomSecret: doorSecret(code),
      relay: deps.transport(relay, GROUP_ROOM_PLAINTEXT_BYTES, svc.signal()),
      plaintextBytes: GROUP_ROOM_PLAINTEXT_BYTES,
      now: () => Math.floor(now() / 1000),
    });
    const { messages } = await room.sync(12);
    const card = messages
      .map(m => ({ m, w: decodeWire(m.body) }))
      .filter(x => x.w?.kind === 'card' && x.w.founder === x.m.author)
      .sort((a, b) => b.m.ts - a.m.ts)[0];
    if (!card || card.w?.kind !== 'card') {
      return null;
    }
    const { G, group, from, count, founder } = card.w;
    const found = { G, group, from, count, founder };
    peeks.set(code, found);
    return found;
  };

  /** ask to join: your room key for this group, your name, your X-Wing key */
  const ask = async (svc: PeopleService, raw: string) => {
    const code = normalizeCode(raw);
    const card = peeks.get(code) ?? (await peek(svc, code));
    const walletId = await deps.walletId();
    if (!card || !walletId) {
      throw new Error('this code opens nothing right now');
    }
    const relay = await deps.relay();
    const gen = await deps.generation(walletId);
    const keys = await deps.keys(walletId, gen, card.G);
    const at = now();
    const door: PeopleRoom = {
      id: doorId(card.G),
      walletId,
      kind: 'door',
      name: card.group,
      appScope: DOOR_SCOPE,
      secret: bytesToHex(doorSecret(code)),
      size: GROUP_ROOM_PLAINTEXT_BYTES,
      relay,
      signer: { gen, G: card.G },
      joined: false,
      createdAt: at,
      until: at + DOOR_MS,
      group: {
        G: card.G,
        founder: card.founder,
        mine: false,
        members: [],
        names: { [card.founder]: card.from },
      },
    };
    await svc.api.addRoom(door);
    await svc.api.send(
      door.id,
      encodeWire({
        kind: 'ask',
        key: keys.pubkey,
        name: shortXid(keys.xid),
        seal: keys.xwingPublicKey,
      }),
      'action',
    );
    return { id: door.id };
  };

  // -- what a pass does with the records it found ----------------------------

  const onDoor: RecordHandler = async (room, records, api) => {
    const g = room.group;
    if (!g) {
      return undefined;
    }
    const wires = records.map(m => ({ m, w: decodeWire(m.body) }));
    if (g.mine) {
      const asks = wires.flatMap(({ m, w }) =>
        // an ask is signed by the key it names: nobody can ask in another's name
        w?.kind === 'ask' && w.key === m.author
          ? [{ key: w.key, name: w.name, sealKey: w.seal, at: m.ts * 1000 }]
          : [],
      );
      const members = new Set(
        ((await api.room(groupId(g.G)))?.group?.members ?? []).map(x => x.key),
      );
      const fresh = asks.filter(a => !members.has(a.key));
      return fresh.length
        ? r => {
            const q = r.group?.requests ?? [];
            const seen = new Set([...q.map(x => x.key), ...(r.group?.declined ?? [])]);
            const add = fresh.filter(a => !seen.has(a.key));
            return add.length ? { ...r, group: { ...r.group!, requests: [...q, ...add] } } : r;
          }
        : undefined;
    }
    if (g.opened) {
      return undefined;
    }
    const me = await api.me(room);
    const invite = wires.find(
      ({ m, w }) => w?.kind === 'invite' && w.to === me && m.author === g.founder,
    );
    if (invite?.w?.kind !== 'invite') {
      return undefined;
    }
    const keys = await keysFor(room);
    const body = openInviteBody(keys.xwingSeed, invite.w.sealed);
    await api.addRoom({
      id: groupId(g.G),
      walletId: room.walletId,
      kind: 'group',
      name: body.group || room.name,
      appScope: ZAFU_GROUP_APP_SCOPE,
      secret: body.secret,
      size: GROUP_ROOM_PLAINTEXT_BYTES,
      relay: body.relay,
      signer: room.signer,
      joined: true,
      createdAt: api.now(),
      group: { G: g.G, founder: g.founder, mine: false, members: [], names: g.names },
    });
    void api.sync(groupId(g.G)).catch(() => undefined);
    return r => ({ ...r, group: { ...r.group!, opened: true }, until: api.now() });
  };

  /**
   * The founder: someone who joined by a memo invite asks in the room itself
   * (only an invited person holds its secret). They go on the roster.
   */
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
    const asks = records.flatMap(m => {
      const w = decodeWire(m.body);
      return w?.kind === 'ask' && w.key === m.author && !roster.has(w.key) ? [w] : [];
    });
    if (!asks.length) {
      return undefined;
    }
    const me = identityOf(await keysFor(room));
    let { records: log } = g.log;
    const names = { ...g.names };
    for (const a of asks) {
      log = [
        ...log,
        await appendRecord({
          genesis: g.log.genesis,
          records: log,
          author: me,
          body: { kind: 'mode', mode: '+v', subject: a.key },
        }),
      ];
      names[a.key] = a.name;
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
    }
    return next;
  };

  const onGroup: RecordHandler = async (seen, records, api) => {
    // the room as it stands after any new member went on the roster
    const room = (await voiceAsks(seen, records, api)) ?? seen;
    const g = room.group;
    if (!g) {
      return undefined;
    }
    let log = g.log;
    let names = g.names;
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
    for (const { m, w } of wires) {
      if (w.kind === 'names' && m.author === g.founder) {
        names = { ...names, ...w.names };
      }
    }
    if (log === g.log && names === g.names) {
      return undefined;
    }
    return r => ({
      ...r,
      group: {
        ...r.group!,
        log,
        names,
        members: log ? rosterOf(log, names, room.createdAt) : r.group!.members,
      },
    });
  };

  return {
    ops: {
      'group-create': (r: Record<string, unknown>, s: PeopleService) =>
        create(s, String(r['name'] ?? '')),
      'group-allow': (r: Record<string, unknown>, s: PeopleService) =>
        allow(s, String(r['G']), String(r['key'])),
      'group-decline': (r: Record<string, unknown>, s: PeopleService) =>
        decline(s, String(r['G']), String(r['key'])),
      'group-renew': (r: Record<string, unknown>, s: PeopleService) => renew(s, String(r['G'])),
      'door-peek': (r: Record<string, unknown>, s: PeopleService) =>
        peek(s, String(r['code'] ?? '')),
      'door-ask': (r: Record<string, unknown>, s: PeopleService) => ask(s, String(r['code'] ?? '')),
    },
    handlers: { door: onDoor, group: onGroup },
  };
};
