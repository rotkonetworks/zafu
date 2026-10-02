/**
 * The people relay service: the one place zafu reads and writes zirc rooms.
 * It runs in the service worker; screens only ask it things.
 *
 * The no-autoconnect contract (design-social 2.10), as code:
 *  - T1 `open()` (the person opened people): one catch-up pass over the rooms
 *    this wallet joined, each from where it last read (`Room.syncSince`).
 *  - T2 `watch(id)` (a thread is on screen): that room every ROOM_POLL_MS.
 *  - T3 after T1, while a zafu window is open: the T1 pass every 5 minutes.
 *  - T4 `check()` ("check again"): the T1 pass, now.
 *  - sending: the write, now.
 * `close()` runs when the last zafu window closes: every timer stops and every
 * request in flight is aborted. There is no alarm, nothing runs at install,
 * unlock, popup open or worker start, and a pass with no rooms makes no
 * request at all.
 *
 * Every relay is gated before the first byte: unless the `people-relay`
 * destination allows it, no transport is even built. Asking happens in the
 * screen that wanted the relay (the ask sheet lives in the UI realm), never
 * here.
 */

import {
  ROOM_POLL_MS,
  Room,
  maxBodyBytes,
  type RoomIdentity,
  type RoomMessage,
} from '@zafu/zirc/room';
import { presenceEpoch, type RelayTransport } from '@zafu/zid';
import { mergeItems, type PeopleRoom, type Thread, type ThreadItem } from './vault';

/** what the slot under a title says (design-social 5.0) */
export type PeopleSlot =
  | 'idle'
  | 'checking'
  | 'checked'
  | 'offline'
  | 'unreachable'
  | 'oversize'
  | 'needs-opt-in'
  | 'blocked'
  | 'locked';

export interface PeopleStatus {
  slot: PeopleSlot;
  /** ms */
  at: number;
}

/** whether a relay may be contacted: on, off until the person says yes, or blocked */
export type Gate = 'on' | 'ask' | 'blocked';

export interface PeopleDeps {
  readRooms: () => Promise<PeopleRoom[] | null>;
  writeRooms: (rooms: PeopleRoom[]) => Promise<boolean>;
  readThreads: () => Promise<Record<string, Thread> | null>;
  writeThreads: (threads: Record<string, Thread>) => Promise<boolean>;
  /** the wallet whose rooms are shown */
  walletId: () => Promise<string | undefined>;
  /** the derived key that speaks in this room */
  identity: (room: PeopleRoom) => Promise<RoomIdentity>;
  gate: (relay: string) => Promise<Gate>;
  /** a transport for one relay; its requests die with `signal` */
  transport: (relay: string, size: number, signal: AbortSignal) => RelayTransport;
  status: (s: PeopleStatus) => void | Promise<void>;
  online?: () => boolean;
  /** ms */
  now?: () => number;
}

/** bodies starting with these are protocol records, never shown as chat */
export const PROTOCOL_PREFIX = /^z[gp]\d:/;

/** what a room kind does with the protocol records a pass found */
export type RecordHandler = (
  room: PeopleRoom,
  records: RoomMessage[],
  api: PeopleApi,
) => Promise<PeopleRoom | undefined>;

export interface PeopleApi {
  send(roomId: string, body: string, kind?: 'msg' | 'action'): Promise<RoomMessage>;
  addRoom(room: PeopleRoom): Promise<void>;
  updateRoom(
    roomId: string,
    fn: (r: PeopleRoom) => PeopleRoom | undefined,
  ): Promise<PeopleRoom | undefined>;
  sync(roomId: string): Promise<PeopleSlot>;
  /** this member's pubkey in a room */
  me(room: PeopleRoom): Promise<string>;
  now(): number;
}

export const threadKey = (room: Pick<PeopleRoom, 'walletId' | 'id'>): string =>
  `${room.walletId}/${room.id}`;

/** catch-up, every 5 minutes after the person opened people (T3) */
export const T3_MS = 5 * 60_000;
/** one pass reads at most this many windows across all rooms */
export const PASS_BUDGET = 600;
/** a room never read reads this far back on its first pass (1 h) */
const FIRST_WINDOWS = 12;

export class PeopleNeedsRelay extends Error {
  constructor(readonly gate: Exclude<Gate, 'on'>) {
    super(gate === 'blocked' ? 'the relay is blocked' : 'the relay is not allowed yet');
  }
}

export const createPeopleService = (
  deps: PeopleDeps,
  handlers: Partial<Record<PeopleRoom['kind'], RecordHandler>> = {},
) => {
  const now = deps.now ?? (() => Date.now());
  interface Session {
    abort: AbortController;
    rooms: Map<string, { room: Room; me: string }>;
    t3?: ReturnType<typeof setInterval>;
    watches: Map<string, { timer: ReturnType<typeof setInterval>; n: number }>;
  }
  let session: Session | undefined;
  const busy = new Map<string, Promise<PeopleSlot>>();

  // every read-modify-write of the vault goes through one queue
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const ensure = (): Session =>
    (session ??= { abort: new AbortController(), rooms: new Map(), watches: new Map() });

  const status = (slot: PeopleSlot) => deps.status({ slot, at: now() });

  const mine = async (): Promise<PeopleRoom[] | null> => {
    const [rooms, wallet] = await Promise.all([deps.readRooms(), deps.walletId()]);
    return rooms && rooms.filter(r => r.walletId === wallet);
  };

  const findRoom = async (roomId: string): Promise<PeopleRoom | undefined> =>
    (await mine())?.find(r => r.id === roomId);

  const updateRoom: PeopleApi['updateRoom'] = (roomId, fn) =>
    serial(async () => {
      const [rooms, wallet] = await Promise.all([deps.readRooms(), deps.walletId()]);
      if (!rooms) {
        return undefined;
      }
      const i = rooms.findIndex(r => r.id === roomId && r.walletId === wallet);
      const next = i < 0 ? undefined : fn(rooms[i]!);
      if (i < 0) {
        return undefined;
      }
      if (next) {
        rooms[i] = next;
      } else {
        rooms.splice(i, 1);
      }
      await deps.writeRooms(rooms);
      return next;
    });

  const addRoom: PeopleApi['addRoom'] = room =>
    serial(async () => {
      const rooms = (await deps.readRooms()) ?? [];
      await deps.writeRooms([
        ...rooms.filter(r => !(r.id === room.id && r.walletId === room.walletId)),
        room,
      ]);
    });

  const writeItems = (room: PeopleRoom, fn: (t: Thread | undefined) => Thread) =>
    serial(async () => {
      const threads = await deps.readThreads();
      if (threads) {
        threads[threadKey(room)] = fn(threads[threadKey(room)]);
        await deps.writeThreads(threads);
      }
    });

  /** the Room for a vault record, built once per session; never before the gate */
  const roomFor = async (rec: PeopleRoom) => {
    const s = ensure();
    const cached = s.rooms.get(threadKey(rec));
    if (cached) {
      return cached;
    }
    const gate = await deps.gate(rec.relay);
    if (gate !== 'on') {
      throw new PeopleNeedsRelay(gate);
    }
    const identity = await deps.identity(rec);
    const room = new Room(
      { ...identity, name: rec.nick ?? identity.name },
      {
        appScope: rec.appScope,
        // a sealed room's coordinate comes from its secret; the name is a label
        channel: '#zafu',
        roomSecret: hexBytes(rec.secret),
        relay: deps.transport(rec.relay, rec.size, s.abort.signal),
        plaintextBytes: rec.size,
        now: () => Math.floor(now() / 1000),
        ...(rec.head ? { head: rec.head } : {}),
      },
    );
    const made = { room, me: identity.pubkey };
    s.rooms.set(threadKey(rec), made);
    return made;
  };

  const toItem = (m: RoomMessage, me: string): ThreadItem => ({
    hash: m.hash,
    author: m.author,
    name: m.name,
    body: m.body,
    ts: m.ts,
    epoch: m.epoch,
    kind: m.kind === 'action' ? 'action' : 'msg',
    mine: m.author === me,
  });

  const syncOne = async (rec: PeopleRoom, maxWindows = 288): Promise<PeopleSlot> => {
    if (deps.online && !deps.online()) {
      return 'offline';
    }
    let made: { room: Room; me: string };
    try {
      made = await roomFor(rec);
    } catch (e) {
      if (e instanceof PeopleNeedsRelay) {
        return e.gate === 'blocked' ? 'blocked' : 'needs-opt-in';
      }
      throw e;
    }
    const { room, me } = made;
    const from = rec.since ?? room.currentEpoch() - (FIRST_WINDOWS - 1);
    const res = await room.syncSince(from, maxWindows);
    if (session?.abort.signal.aborted) {
      return 'idle';
    }
    const unreachable = res.dropped.some(d => d.kind === 'unreachable');
    const oversize = res.dropped.some(d => d.kind === 'oversize');
    const msgs = res.messages.filter(m => m.kind !== 'dm');
    const chat = msgs.filter(m => !PROTOCOL_PREFIX.test(m.body)).map(m => toItem(m, me));
    if (chat.length) {
      await writeItems(rec, t => mergeItems(t, chat));
    }
    let next: PeopleRoom = {
      ...rec,
      head: room.chainHead(),
      // a window that failed is read again next time
      since: unreachable ? from : room.currentEpoch(),
    };
    const handle = handlers[rec.kind];
    const proto = msgs.filter(m => PROTOCOL_PREFIX.test(m.body));
    if (handle && proto.length) {
      next = (await handle(next, proto, api)) ?? next;
    }
    await updateRoom(rec.id, r => ({
      ...r,
      ...next,
      // the handler may have changed membership meanwhile; keep the newest
      group: next.group ?? r.group,
    }));
    return unreachable ? 'unreachable' : oversize ? 'oversize' : 'checked';
  };

  /** one room, never two passes over it at once */
  const sync = (roomId: string, maxWindows?: number): Promise<PeopleSlot> => {
    const running = busy.get(roomId);
    if (running) {
      return running;
    }
    const run = (async () => {
      const rec = await findRoom(roomId);
      return rec ? syncOne(rec, maxWindows) : ('idle' as const);
    })().finally(() => busy.delete(roomId));
    busy.set(roomId, run);
    return run;
  };

  /** the rooms a pass reads: joined ones, and doors still open */
  const live = (rooms: PeopleRoom[]) =>
    rooms
      .filter(r => r.joined || (r.kind === 'door' && (r.until ?? 0) > now()))
      .sort((a, b) => (b.since ?? 0) - (a.since ?? 0));

  const WORST: PeopleSlot[] = [
    'locked',
    'blocked',
    'needs-opt-in',
    'offline',
    'unreachable',
    'oversize',
    'checked',
    'idle',
  ];

  /** T1, T3 and T4: every live room once, the most recent first, within budget */
  const pass = async (): Promise<PeopleSlot> => {
    const rooms = await mine();
    if (!rooms) {
      await status('locked');
      return 'locked';
    }
    const todo = live(rooms);
    if (!todo.length) {
      return 'idle';
    }
    await status('checking');
    let budget = PASS_BUDGET;
    const slots: PeopleSlot[] = [];
    const current = presenceEpoch(Math.floor(now() / 1000));
    for (const rec of todo) {
      const need = Math.min(288, current - (rec.since ?? current - FIRST_WINDOWS + 1) + 1);
      if (need > budget || !session) {
        break; // the rest catch up when they are opened
      }
      budget -= need;
      slots.push(await sync(rec.id, need).catch(() => 'unreachable' as const));
    }
    const slot = WORST.find(s => slots.includes(s)) ?? 'checked';
    await status(slot);
    return slot;
  };

  const send: PeopleApi['send'] = async (roomId, body, kind = 'msg') => {
    const rec = await findRoom(roomId);
    if (!rec) {
      throw new Error('no such room');
    }
    const { room, me } = await roomFor(rec);
    const sent = await room.send(body, { kind });
    await updateRoom(roomId, r => ({ ...r, head: room.chainHead() }));
    if (!PROTOCOL_PREFIX.test(body)) {
      await writeItems(rec, t => mergeItems(t, [toItem(sent, me)]));
    }
    return sent;
  };

  const api: PeopleApi = {
    send,
    addRoom,
    updateRoom,
    sync: id => sync(id),
    me: async room => (await deps.identity(room)).pubkey,
    now,
  };

  return {
    api,
    /** T1: the person opened people */
    open: async (): Promise<PeopleSlot> => {
      const s = ensure();
      s.t3 ??= setInterval(() => void pass().catch(() => undefined), T3_MS);
      return pass();
    },
    /** T4: "check again" */
    check: (): Promise<PeopleSlot> => {
      ensure();
      return pass();
    },
    /** T2: a thread is on screen. Returns the stop. */
    watch: (roomId: string): (() => void) => {
      const s = ensure();
      const w = s.watches.get(roomId);
      if (w) {
        w.n++;
      } else {
        void sync(roomId).catch(() => undefined);
        s.watches.set(roomId, {
          n: 1,
          timer: setInterval(() => void sync(roomId).catch(() => undefined), ROOM_POLL_MS),
        });
      }
      return () => {
        const cur = session?.watches.get(roomId);
        if (cur && --cur.n <= 0) {
          clearInterval(cur.timer);
          session?.watches.delete(roomId);
        }
      };
    },
    /** a line typed in a thread: shown at once as "sending", then on the relay */
    say: async (roomId: string, text: string): Promise<'sent' | PeopleSlot> => {
      const rec = await findRoom(roomId);
      if (!rec) {
        return 'idle';
      }
      const local = crypto.randomUUID();
      const draft: ThreadItem = {
        hash: '',
        local,
        author: '',
        name: rec.nick ?? '',
        body: text,
        ts: Math.floor(now() / 1000),
        epoch: 0,
        kind: text.startsWith('/me ') ? 'action' : 'msg',
        mine: true,
        status: 'sending',
      };
      await writeItems(rec, t => mergeItems(t, [draft]));
      const settle = (fn: (i: ThreadItem) => ThreadItem | undefined) =>
        writeItems(rec, t => ({
          read: t?.read ?? 0,
          items: (t?.items ?? []).flatMap(i => (i.local === local ? (fn(i) ?? []) : [i])),
        }));
      try {
        await send(roomId, draft.kind === 'action' ? text.slice(4) : text, draft.kind);
        await settle(() => undefined);
        return 'sent';
      } catch (e) {
        await settle(i => ({ ...i, status: 'failed' }));
        if (e instanceof PeopleNeedsRelay) {
          return e.gate === 'blocked' ? 'blocked' : 'needs-opt-in';
        }
        return 'unreachable';
      }
    },
    /** mark a thread read up to now */
    read: (roomId: string) =>
      findRoom(roomId).then(
        rec =>
          rec && writeItems(rec, t => ({ items: t?.items ?? [], read: Math.floor(now() / 1000) })),
      ),
    /** the last zafu window closed: stop everything, abort what is in flight */
    close: () => {
      if (!session) {
        return;
      }
      session.abort.abort();
      clearInterval(session.t3);
      for (const w of session.watches.values()) {
        clearInterval(w.timer);
      }
      session = undefined;
    },
    get active() {
      return !!session;
    },
    /** resolves when no room is being read (tests) */
    settled: () => Promise.all([...busy.values()]).then(() => undefined),
  };
};

export type PeopleService = ReturnType<typeof createPeopleService>;

/** the body limit in a room of this size, for a nick */
export const bodyLimit = (size: number, nick = '00000000'): number =>
  maxBodyBytes(nick, '', undefined, size);

const hexBytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], b => parseInt(b, 16));
