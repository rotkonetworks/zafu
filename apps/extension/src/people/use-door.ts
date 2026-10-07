/**
 * The screens' side of a door (people/door-run): while people, a group or a
 * code is on screen, each open door of this wallet does its SPAKE2 step on
 * the zcash worker as soon as its mailbox brings something new. Closed, zafu
 * does nothing: a joiner waits until the founder next opens zafu, within the
 * door's hour.
 */

import { useEffect } from 'react';
import { doorPakeInWorker } from '../state/keyring/network-worker';
import { peopleCall, useMyRooms } from './client';
import { groupId } from './groups';
import { hostStep, joinStep } from './door-run';
import { readRooms } from './vault';

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

/** every open door of this wallet: read while shown, and its step done as records arrive */
export const useDoors = (): void => {
  const doors = useMyRooms().filter(r => r.door && (r.until ?? 0) > Date.now());
  const sig = doors
    .map(r => `${r.walletId}/${r.id}:${r.door!.heard.length}:${r.door!.sent?.length ?? 0}`)
    .join('|');
  useEffect(() => {
    for (const d of doors) {
      kick(d.walletId, d.id);
    }
    // the doors' records, not each copy of their rooms, decide a new step
  }, [sig]);
};
