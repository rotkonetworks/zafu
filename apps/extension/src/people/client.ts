/**
 * The screens' side of the people relay: ask the worker, and read what it
 * wrote. Rooms and messages arrive through storage (sealed, opened here with
 * the session key), so every open zafu window sees the same thing at once.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useStore } from '../state';
import { selectEffectiveKeyInfo } from '../state/keyring';
import { requestEgressOptIn } from '../net/egress-opt-in';
import { PEOPLE_RELAY } from '../config/people-relay';
import { PEOPLE_MESSAGE, PEOPLE_STATUS_KEY, PEOPLE_WATCH_PORT } from './protocol';
import {
  onRoster,
  readInvites,
  readRooms,
  readThreads,
  threadKey,
  type PeopleRoom,
  type StoredInvite,
  type Thread,
} from './vault';
import { hasMemoInvite } from './memo-door';
import {
  cardB64,
  cardFromMemos,
  exactCardV2,
  readCardV2,
} from '@repo/wallet/networks/zcash/card-v2';
import type { PeopleSlot, PeopleStatus } from './service';

export const peopleCall = async <T = unknown>(
  op: string,
  args: Record<string, unknown> = {},
): Promise<T> => {
  const r: { ok: true; value: T } | { ok: false; error: string } | undefined =
    await chrome.runtime.sendMessage({ type: PEOPLE_MESSAGE, op, ...args });
  if (!r?.ok) {
    throw new Error(r && !r.ok ? r.error : 'zafu did not answer');
  }
  return r.value;
};

interface Snapshot {
  rooms: PeopleRoom[];
  threads: Record<string, Thread>;
  invites: StoredInvite[];
  status?: PeopleStatus;
}

let snap: Snapshot = { rooms: [], threads: {}, invites: [] };
const subs = new Set<() => void>();
let loading: Promise<void> | undefined;

const load = (): Promise<void> =>
  (loading ??= (async () => {
    const [rooms, threads, invites, s] = await Promise.all([
      readRooms(),
      readThreads(),
      readInvites(),
      chrome.storage.session.get(PEOPLE_STATUS_KEY),
    ]);
    snap = {
      rooms: rooms ?? [],
      threads: threads ?? {},
      invites,
      status: s[PEOPLE_STATUS_KEY] as PeopleStatus | undefined,
    };
    subs.forEach(f => f());
  })().finally(() => (loading = undefined)));

let listening = false;
const subscribe = (f: () => void) => {
  subs.add(f);
  if (!listening) {
    listening = true;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (
        (area === 'local' &&
          ('peopleRooms' in changes || 'peopleThreads' in changes || 'peopleInvites' in changes)) ||
        (area === 'session' && (PEOPLE_STATUS_KEY in changes || 'passwordKey' in changes))
      ) {
        void load();
      }
    });
    void load();
  }
  return () => subs.delete(f);
};

/** everything the worker wrote, for every wallet: screens select what they show */
export const usePeople = (): Snapshot => useSyncExternalStore(subscribe, () => snap);

export const usePeopleSlot = (): PeopleSlot => usePeople().status?.slot ?? 'idle';

/** T1: this screen is people */
export const useOpenPeople = (): void =>
  useEffect(() => {
    void peopleCall('open').catch(() => undefined);
  }, []);

/** T2: this room is on screen; the port's end is the poll's end */
export const useWatchRoom = (roomId: string | undefined): void =>
  useEffect(() => {
    if (!roomId) {
      return;
    }
    const port = chrome.runtime.connect({ name: PEOPLE_WATCH_PORT + roomId });
    return () => port.disconnect();
  }, [roomId]);

/** the relay is off until the person says yes: ask once, here, then try again */
export const peopleAsk = async <T = unknown>(
  op: string,
  args: Record<string, unknown> = {},
): Promise<T> => {
  try {
    return await peopleCall<T>(op, args);
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes('not allowed yet')) {
      throw e;
    }
    if (!(await requestEgressOptIn(PEOPLE_RELAY))) {
      throw e;
    }
    return peopleCall<T>(op, args);
  }
};

/** the active wallet's rooms, by id */
export const useMyRooms = (): PeopleRoom[] => {
  const walletId = useStore(s => selectEffectiveKeyInfo(s)?.id);
  const { rooms } = usePeople();
  return useMemo(() => rooms.filter(r => r.walletId === walletId), [rooms, walletId]);
};

/** a room's thread as it is shown: a group's only from its roster (see `onRoster`) */
export const useThread = (room: PeopleRoom | undefined): Thread | undefined => {
  const { threads } = usePeople();
  const t = room ? threads[threadKey(room)] : undefined;
  return useMemo(() => onRoster(room, t), [room, t]);
};

/** say a line in a room; the first time, ask for the relay and say it again */
export const peopleSay = async (roomId: string, text: string, retry?: string): Promise<string> => {
  const first = await peopleCall<string>('say', { roomId, text, retry });
  if (first !== 'needs-opt-in' || !(await requestEgressOptIn(PEOPLE_RELAY))) {
    return first;
  }
  return peopleCall<string>('say', { roomId, text, retry });
};

/**
 * The memo-ingest seam (see ./invites): every memo the zcash and penumbra
 * syncs decode that carries a zafu invite goes to the worker, which keeps it
 * until the person answers. Nothing here or there touches a relay.
 */
export const ingestMemoInvites = (
  memos: {
    network: 'zcash' | 'penumbra';
    txId: string;
    content: string;
    timestamp?: number;
    from?: string;
    direction?: string;
  }[],
): void => {
  for (const m of memos) {
    if (m.direction !== 'sent' && hasMemoInvite(m.content)) {
      void peopleCall('memo-ingest', {
        network: m.network,
        txId: m.txId,
        content: m.content,
        at: m.timestamp,
        from: m.from,
      }).catch(() => undefined);
    }
  }
};

/**
 * v2 cards that came as memos (an answer to a card you showed, sent by
 * memo when the relay was down): one card per transaction, its fragments
 * together. The worker matches it to the card it answers.
 */
export const ingestCardMemos = (
  notes: { txid: string; height: number; memo: Uint8Array; isChange: boolean }[],
): void => {
  const byTx = new Map<string, { height: number; memos: Uint8Array[] }>();
  for (const n of notes) {
    // by type only: a later fragment's first byte is mid-card; the reader checks the version
    if (!n.isChange && n.memo[2] === 0x05) {
      const t = byTx.get(n.txid) ?? { height: n.height, memos: [] };
      t.memos.push(n.memo);
      byTx.set(n.txid, t);
    }
  }
  for (const [txId, t] of byTx) {
    const padded = cardFromMemos(t.memos);
    const bytes = padded && exactCardV2(padded);
    if (bytes && readCardV2(bytes)?.kind === 'answer') {
      void peopleCall('card-memo', {
        card: cardB64(bytes),
        txId,
        height: t.height,
      }).catch(() => undefined);
    }
  }
};

/** the active wallet's open invites */
export const useMyInvites = (): StoredInvite[] => {
  const walletId = useStore(s => selectEffectiveKeyInfo(s)?.id);
  const { invites } = usePeople();
  return useMemo(
    () => invites.filter(i => i.walletId === walletId && i.state === 'open'),
    [invites, walletId],
  );
};
