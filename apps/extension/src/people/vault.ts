/**
 * What the people relay keeps on this device: the rooms you are in (their
 * secrets, where they live, your chain head and how far you have read) and a
 * cache of their messages. Both are sealed at rest with the session key, like
 * contacts and memos, and both go into the encrypted personal-data backup,
 * the messages capped at {@link THREAD_CAP} per thread (founder answer 3).
 *
 * Nothing secret about a room KEY is ever stored: it is derived from the seed
 * and `(gen, genesis id)` (or `(gen, j)` for a pair room) each time.
 */

import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import type { LocalStorageState } from '@repo/storage-chrome/local';
import type { ChannelGenesis, ChannelRecord } from '@zafu/zirc';
import type { MemoDoorRead } from './memo-door';
import { readEncrypted, writeEncrypted } from '../state/encrypted-storage';

export type PeopleRoomKind = 'group' | 'door' | 'pair';

/** a group's roster as the founder wrote it: who is in, by room pubkey */
export interface GroupMember {
  /** room pubkey, hex */
  key: string;
  name: string;
  /** X-Wing public key (hex), what an invite to them is sealed to */
  sealKey?: string;
  at: number;
}

/** someone asking to join through a door, waiting for the founder's "allow" */
export interface JoinRequest {
  key: string;
  name: string;
  sealKey: string;
  at: number;
}

export interface PeopleRoom {
  /** `g:<G>` a group, `d:<G>` its door, `p:<personId>` a pair room */
  id: string;
  walletId: string;
  kind: PeopleRoomKind;
  /** the group's name, or the person's */
  name: string;
  appScope: string;
  /** 32-byte room secret, hex */
  secret: string;
  /** fixed plaintext size of every entry in this room */
  size: number;
  /** relay base url */
  relay: string;
  /** which derived key speaks here: a room key `(gen, G)` or a relationship `(gen, j)` */
  signer: { gen: number; G?: string; j?: number };
  /** your name in this room (`/nick`), a user setting, so it is backed up */
  nick?: string;
  head?: { seq: number; hash: string };
  /** the last window read (`Room.syncSince`) */
  since?: number;
  /** false while you only asked to join */
  joined: boolean;
  createdAt: number;
  /** a door closes at this time (ms) */
  until?: number;
  /** groups and doors */
  group?: {
    G: string;
    /** the founder's room pubkey */
    founder: string;
    /** true when this wallet founded it */
    mine: boolean;
    members: GroupMember[];
    requests?: JoinRequest[];
    /** asks the founder said no to: never shown again */
    declined?: string[];
    /** a door: the group it opens, and its code (founder side only) */
    code?: string;
    /** joiner side: the invite was opened and the group joined */
    opened?: boolean;
    /** the roster log as far as it verifies from genesis */
    log?: { genesis: ChannelGenesis; records: ChannelRecord[] };
    /** what members call themselves, as the founder last posted it */
    names?: Record<string, string>;
  };
  /** pair rooms */
  pair?: {
    personId: string;
    /** the peer's inception key, hex, once known */
    peer?: string;
    /** waiting for them to answer a memo invite */
    waiting?: boolean;
    /** the card their answer carried, until the screen saves it on the contact */
    card?: PairCard;
    /**
     * answers to your memo invite you have not confirmed: anyone who can read
     * that memo can answer, so none of them becomes the person until you say
     * which one is them (or it carries the key you already hold for them)
     */
    answers?: PairCard[];
  };
}

/** what an answering card says about the person on the other side */
export interface PairCard {
  zid: string;
  pairKa: string;
  address: string;
  name: string;
}

export interface ThreadItem {
  /** record hash, the dedupe key ('' while sending) */
  hash: string;
  author: string;
  name: string;
  body: string;
  /** author clock, seconds */
  ts: number;
  epoch: number;
  kind: 'msg' | 'action';
  mine: boolean;
  status?: 'sending' | 'failed';
  /** local id of an item not yet on the relay */
  local?: string;
}

export interface Thread {
  items: ThreadItem[];
  /** seconds: items at or before this are read */
  read: number;
}

/** a thread is one room seen from one wallet */
export const threadKey = (room: Pick<PeopleRoom, 'walletId' | 'id'>): string =>
  `${room.walletId}/${room.id}`;

/** relay history kept per thread, here and in the backup */
export const THREAD_CAP = 500;

const ROOMS_KEY = 'peopleRooms' as keyof LocalStorageState;
const THREADS_KEY = 'peopleThreads' as keyof LocalStorageState;

/** null when locked */
export const readRooms = async (): Promise<PeopleRoom[] | null> => {
  if (!(await sessionExtStorage.get('passwordKey'))) {
    return null;
  }
  const v = await readEncrypted<unknown>(localExtStorage, sessionExtStorage, ROOMS_KEY);
  return Array.isArray(v) ? (v as PeopleRoom[]) : [];
};

export const writeRooms = (rooms: PeopleRoom[]): Promise<boolean> =>
  writeEncrypted(localExtStorage, sessionExtStorage, ROOMS_KEY, rooms);

/** null when locked */
export const readThreads = async (): Promise<Record<string, Thread> | null> => {
  if (!(await sessionExtStorage.get('passwordKey'))) {
    return null;
  }
  const v = await readEncrypted<unknown>(localExtStorage, sessionExtStorage, THREADS_KEY);
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Thread>) : {};
};

export const writeThreads = (threads: Record<string, Thread>): Promise<boolean> =>
  writeEncrypted(localExtStorage, sessionExtStorage, THREADS_KEY, threads);

export interface StoredInvite {
  /** the memo's txid: one invite per memo */
  id: string;
  walletId: string;
  network: 'zcash' | 'penumbra';
  /** ms */
  at: number;
  /** the memo's own return address, when it had one */
  from?: string;
  read: MemoDoorRead;
  state: 'open' | 'declined' | 'accepted';
}

const INVITES_KEY = 'peopleInvites' as keyof LocalStorageState;

export const readInvites = async (): Promise<StoredInvite[]> => {
  const v = await readEncrypted<unknown>(localExtStorage, sessionExtStorage, INVITES_KEY);
  return Array.isArray(v) ? (v as StoredInvite[]) : [];
};

export const writeInvites = (all: StoredInvite[]) =>
  writeEncrypted(localExtStorage, sessionExtStorage, INVITES_KEY, all);

export const PEOPLE_STORAGE_KEYS = [ROOMS_KEY, THREADS_KEY] as const;

const order = (a: ThreadItem, b: ThreadItem) =>
  a.ts - b.ts || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0);

/** fold arrived records into a thread: dedupe by hash, oldest first, capped */
export const mergeItems = (thread: Thread | undefined, items: ThreadItem[]): Thread => {
  const byHash = new Map<string, ThreadItem>();
  const pending: ThreadItem[] = [];
  for (const it of [...(thread?.items ?? []), ...items]) {
    if (it.hash) {
      byHash.set(it.hash, it);
    } else {
      pending.push(it);
    }
  }
  return {
    read: thread?.read ?? 0,
    items: [...byHash.values(), ...pending].sort(order).slice(-THREAD_CAP),
  };
};

/** unread: other people's lines after `read` */
export const unreadOf = (t?: Thread): number =>
  t ? t.items.filter(i => !i.mine && i.ts > t.read).length : 0;

// -- backup ----------------------------------------------------------------

export interface PeopleBackup {
  rooms: PeopleRoom[];
  threads: Record<string, Thread>;
}

export const readPeopleBackup = async (): Promise<PeopleBackup | undefined> => {
  const [rooms, threads] = [await readRooms(), await readThreads()];
  if (!rooms?.length) {
    return undefined;
  }
  return {
    rooms,
    threads: Object.fromEntries(
      Object.entries(threads ?? {}).map(([id, t]) => [
        id,
        { read: t.read, items: t.items.filter(i => i.hash).slice(-THREAD_CAP) },
      ]),
    ),
  };
};

const isRoom = (r: unknown): r is PeopleRoom => {
  const x = r as PeopleRoom;
  return (
    !!x &&
    typeof x.id === 'string' &&
    typeof x.walletId === 'string' &&
    typeof x.secret === 'string' &&
    typeof x.relay === 'string' &&
    typeof x.appScope === 'string'
  );
};

/** merge a backup's rooms (by id) and messages (by hash) into what is here */
export const restorePeopleBackup = async (
  raw: unknown,
  mode: 'merge' | 'replace',
): Promise<number> => {
  const b = raw as Partial<PeopleBackup> | undefined;
  const rooms = Array.isArray(b?.rooms) ? b.rooms.filter(isRoom) : [];
  if (!rooms.length) {
    return 0;
  }
  const hereRooms = mode === 'replace' ? [] : ((await readRooms()) ?? []);
  const hereThreads = mode === 'replace' ? {} : ((await readThreads()) ?? {});
  const ids = new Set(hereRooms.map(r => r.id + r.walletId));
  const added = rooms.filter(r => !ids.has(r.id + r.walletId));
  const threads = { ...hereThreads };
  for (const [id, t] of Object.entries(b?.threads ?? {})) {
    if (t && Array.isArray(t.items)) {
      const merged = mergeItems(threads[id], t.items);
      threads[id] = { ...merged, read: Math.max(merged.read, Number(t.read) || 0) };
    }
  }
  await writeRooms([...hereRooms, ...added]);
  await writeThreads(threads);
  return added.length;
};

/** a removed wallet's rooms, messages and memo invites go with it */
export const purgePeople = async (walletId: string): Promise<void> => {
  const [rooms, threads] = [await readRooms(), await readThreads()];
  const invites = await readInvites();
  if (invites.some(i => i.walletId === walletId)) {
    await writeInvites(invites.filter(i => i.walletId !== walletId));
  }
  if (rooms) {
    await writeRooms(rooms.filter(r => r.walletId !== walletId));
  }
  if (threads) {
    await writeThreads(
      Object.fromEntries(Object.entries(threads).filter(([k]) => !k.startsWith(`${walletId}/`))),
    );
  }
};
