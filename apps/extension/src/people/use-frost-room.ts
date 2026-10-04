/**
 * The screens' side of a shared wallet made in a room (see ./frost-room):
 * while a thread is open, this device does its part of the ceremony with the
 * FROST worker, keeps its round state in the room (sealed at rest, so the
 * popup can close mid-ceremony and pick up where it was), and saves its seat
 * once every member's keys match.
 */

import { useEffect, useMemo, useState } from 'react';
import { hexToBytes } from '@noble/hashes/utils';
import { encodeOrchardUnifiedAddress } from '@repo/wallet/networks/zcash/unified-address';
import { useStore } from '../state';
import { deriveRelationshipKeys, deriveRoomKeys, type XidKeys } from '../state/identity';
import {
  frostDeriveAddressFromSkInWorker,
  frostDeriveUfvkInWorker,
  frostDkgPart1InWorker,
  frostDkgPart2InWorker,
  frostDkgPart3InWorker,
  frostSampleFvkSkInWorker,
} from '../state/keyring/network-worker';
import type { ZcashWalletJson } from '../state/wallets';
import { peopleAsk, peopleCall } from './client';
import {
  advance,
  allowedIn,
  ceremonyOf,
  packFrost,
  startBody,
  type Ceremony,
  type Deal,
  type FrostCalls,
  type FrostMine,
  type Seat,
} from './frost-room';
import { readRooms, type PeopleRoom } from './vault';

const frost: FrostCalls = {
  part1: frostDkgPart1InWorker,
  part2: frostDkgPart2InWorker,
  part3: frostDkgPart3InWorker,
  sampleSk: frostSampleFvkSkInWorker,
  ufvk: (pkp, sk) => frostDeriveUfvkInWorker(pkp, sk, true),
  address: async (pkp, sk) =>
    encodeOrchardUnifiedAddress(
      hexToBytes(await frostDeriveAddressFromSkInWorker(pkp, sk, 0)),
      true,
    ),
};

const keys = new Map<string, Promise<XidKeys>>();

/** the key this wallet speaks with in a room, derived once per window */
export const roomKeysOf = (room: PeopleRoom): Promise<XidKeys> => {
  const { gen, j, G } = room.signer;
  const id = `${room.walletId}/${gen}/${j ?? G}`;
  let k = keys.get(id);
  if (!k) {
    k = useStore
      .getState()
      .keyRing.getMnemonic(room.walletId)
      .then(m =>
        j !== undefined ? deriveRelationshipKeys(m, gen, j) : deriveRoomKeys(m, gen, G!),
      );
    k.catch(() => keys.delete(id));
    keys.set(id, k);
  }
  return k;
};

const save = (room: PeopleRoom) => async (seat: Seat) => {
  const st = useStore.getState();
  if (st.wallets.zcashWallets.some(w => w.multisig?.publicKeyPackage === seat.publicKeyPackage)) {
    return;
  }
  await st.keyRing.newFrostMultisigKey({
    label: seat.label,
    address: seat.address,
    orchardFvk: seat.orchardFvk,
    keyPackage: seat.keyPackage,
    publicKeyPackage: seat.publicKeyPackage,
    ephemeralSeed: seat.ephemeralSeed,
    threshold: seat.threshold,
    maxSigners: seat.maxSigners,
    relayUrl: room.relay,
    custody: 'self',
    room: { walletId: room.walletId, roomId: room.id, ceremony: seat.ceremony },
  });
};

/** the same message is said at most once per 20 s, until the room shows it */
const said = new Map<string, number>();
const paced = async (key: string, post: () => Promise<unknown>) => {
  if (Date.now() - (said.get(key) ?? 0) < 20_000) {
    return;
  }
  said.set(key, Date.now());
  try {
    await post();
  } catch (e) {
    said.delete(key);
    throw e;
  }
};

/** one pass at a time per room; a change while it runs runs it once more after */
const runs = new Map<string, { again: boolean }>();

const step = async (walletId: string, roomId: string) => {
  const room = (await readRooms())?.find(r => r.id === roomId && r.walletId === walletId);
  if (!room?.frost) {
    return;
  }
  const me = await roomKeysOf(room);
  const c = ceremonyOf(room.frost.msgs, allowedIn(room, me.pubkey));
  await advance(c, c && room.frost.mine?.[c.id], me, frost, {
    post: (bodies, key) =>
      paced(`${roomId}/${key}`, () => peopleCall('frost-post', { roomId, bodies })),
    keep: (id, patch) => peopleCall<FrostMine>('frost-keep', { roomId, id, patch }),
    save: save(room),
  });
};

const kick = (walletId: string, roomId: string) => {
  const key = `${walletId}/${roomId}`;
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
        await step(walletId, roomId).catch((e: unknown) =>
          console.warn(
            '[frost-room] this step did not finish; it is tried again:',
            e instanceof Error ? (e.stack ?? e.message) : String(e),
          ),
        );
      }
    } finally {
      runs.delete(key);
    }
  })();
};

/** the seat a room's ceremony left in this wallet, if it finished here */
export const seatOf = (
  wallets: ZcashWalletJson[],
  room: PeopleRoom | undefined,
): ZcashWalletJson | undefined =>
  room
    ? wallets.find(
        w => w.multisig?.room?.roomId === room.id && w.multisig.room.walletId === room.walletId,
      )
    : undefined;

export interface FrostView {
  me?: string;
  ceremony?: Ceremony;
  /** what this device did in it */
  mine?: FrostMine;
  seat?: ZcashWalletJson;
}

/** a room's ceremony as this wallet sees it, and this device doing its part while it is shown */
export const useFrostRoom = (room: PeopleRoom | undefined): FrostView => {
  const wallets = useStore(s => s.wallets.zcashWallets);
  const seat = seatOf(wallets, room);
  const msgs = room?.frost?.msgs;
  const me = useMe(room);
  const ceremony = useMemo(
    () => (room && me ? ceremonyOf(msgs, allowedIn(room, me)) : undefined),
    [room, me, msgs],
  );
  // the worker is an external system: each new message may let this device do its part
  const live = !!room && !!me && !!ceremony?.members.includes(me) && !seat;
  useEffect(() => {
    if (live) {
      kick(room.walletId, room.id);
    }
  }, [live, room, msgs?.length]);
  // a step that failed (the relay did not answer) is tried again while this is on screen
  useEffect(() => {
    if (!live) {
      return;
    }
    const t = setInterval(() => kick(room.walletId, room.id), 10_000);
    return () => clearInterval(t);
  }, [live, room?.walletId, room?.id]);
  return { me, ceremony, mine: ceremony && room?.frost?.mine?.[ceremony.id], seat };
};

/** agree to a deal someone proposed: this device then makes its share */
export const agree = (roomId: string, id: string) =>
  peopleCall<FrostMine>('frost-keep', { roomId, id, patch: { ok: true } });

/** this wallet's key in a room: derived from the seed, so it waits for the derivation */
const useMe = (room: PeopleRoom | undefined): string | undefined => {
  const id = room && `${room.walletId}/${room.id}`;
  const [me, setMe] = useState<{ id: string; key: string }>();
  useEffect(() => {
    if (room) {
      void roomKeysOf(room).then(
        k => setMe({ id: `${room.walletId}/${room.id}`, key: k.pubkey }),
        () => undefined,
      );
    }
    // the key follows the room's identity, not each copy of its record
  }, [id]);
  return me && me.id === id ? me.key : undefined;
};

/** say "make keys together": a start with the members fixed now */
export const startKeys = async (
  roomId: string,
  members: string[],
  k: number,
  label: string,
  more?: { deal?: Deal; replaces?: string },
) =>
  peopleAsk('frost-post', { roomId, bodies: await packFrost(startBody(members, k, label, more)) });
