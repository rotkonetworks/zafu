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
import { readRooms, readThreads, threadKey, type PeopleRoom, type Thread } from './vault';
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
  status?: PeopleStatus;
}

let snap: Snapshot = { rooms: [], threads: {} };
const subs = new Set<() => void>();
let loading: Promise<void> | undefined;

const load = (): Promise<void> =>
  (loading ??= (async () => {
    const [rooms, threads, s] = await Promise.all([
      readRooms(),
      readThreads(),
      chrome.storage.session.get(PEOPLE_STATUS_KEY),
    ]);
    snap = {
      rooms: rooms ?? [],
      threads: threads ?? {},
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
        (area === 'local' && ('peopleRooms' in changes || 'peopleThreads' in changes)) ||
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

export const useThread = (room: PeopleRoom | undefined): Thread | undefined => {
  const { threads } = usePeople();
  return room ? threads[threadKey(room)] : undefined;
};

/** say a line in a room; the first time, ask for the relay and say it again */
export const peopleSay = async (roomId: string, text: string, retry?: string): Promise<string> => {
  const first = await peopleCall<string>('say', { roomId, text, retry });
  if (first !== 'needs-opt-in' || !(await requestEgressOptIn(PEOPLE_RELAY))) {
    return first;
  }
  return peopleCall<string>('say', { roomId, text, retry });
};
