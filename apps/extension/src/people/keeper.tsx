/**
 * What zafu does for the people waiting on you, on whichever screen is open:
 * the rooms someone waits on (people/hurry) are read fast, each open code
 * does its SPAKE2 step (people/door-run) on the zcash worker as soon as its
 * mailbox brings something new, and a shared wallet makes this device's
 * share of its keys. It lives in the popup's shell, so it ends with the last
 * window: closed, zafu does nothing, and a joiner waits until the founder
 * next opens zafu, within the code's hour.
 */

import { useEffect } from 'react';
import { doorPakeInWorker } from '../state/keyring/network-worker';
import { peopleCall, useMyRooms, useWatchRoom } from './client';
import { groupId } from './protocol';
import { hostStep, joinStep } from './door-run';
import { hurried } from './hurry';
import { useFrostRoom } from './use-frost-room';
import { useConnectSteps } from './connect-page';
import { readRooms, type PeopleRoom } from './vault';

/** one step at a time per door; a change while it runs runs it once more after */
const runs = new Map<string, { again: boolean }>();

const step = async (walletId: string, id: string) => {
  const rooms = (await readRooms())?.filter(r => r.walletId === walletId) ?? [];
  const door = rooms.find(r => r.id === id);
  if (!door?.door || (door.until ?? 0) <= Date.now()) {
    return;
  }
  await (door.door.role === 'host'
    ? hostStep(
        door,
        rooms.find(r => r.id === groupId(door.signer.G!)),
        doorPakeInWorker,
        peopleCall,
      )
    : joinStep(door, doorPakeInWorker, peopleCall));
};

const kick = (walletId: string, id: string) => {
  const key = `${walletId}/${id}`;
  const running = runs.get(key);
  if (running) {
    running.again = true;
    return;
  }
  const state = { again: true };
  runs.set(key, state);
  void (async () => {
    try {
      while (state.again) {
        state.again = false;
        await step(walletId, id).catch((e: unknown) =>
          console.warn('[door] this step did not finish; it is tried again:', String(e)),
        );
      }
    } finally {
      runs.delete(key);
    }
  })();
};

/** one room someone waits on: read fast, and this device's part of its keys done */
const Keep = ({ room }: { room: PeopleRoom }) => {
  useWatchRoom(room.id);
  useFrostRoom(room.kind === 'door' ? undefined : room);
  return null;
};

export const PeopleKeeper = () => {
  const rooms = useMyRooms();
  useConnectSteps(rooms);
  const hot = hurried(rooms, Date.now());
  const doors = rooms.filter(r => r.kind === 'door' && hot.has(r.id));
  const sig = doors
    .map(r => `${r.walletId}/${r.id}:${r.door!.heard.length}:${r.door!.sent?.length ?? 0}`)
    .join('|');
  useEffect(() => {
    for (const d of doors) {
      kick(d.walletId, d.id);
    }
    // the doors' records, not each copy of their rooms, decide a new step
  }, [sig]);
  return rooms.filter(r => hot.has(r.id)).map(r => <Keep key={r.id} room={r} />);
};
