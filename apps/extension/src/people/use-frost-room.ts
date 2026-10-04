/**
 * The screens' side of a shared wallet made in a room (see ./frost-room):
 * while a thread is open, this device does its part of the ceremony with the
 * FROST worker, keeps its round state in the room (sealed at rest, so the
 * popup can close mid-ceremony and pick up where it was), and saves its seat
 * once every member's keys match.
 */

import { useEffect, useMemo, useState } from 'react';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { encodeOrchardUnifiedAddress } from '@repo/wallet/networks/zcash/unified-address';
import { useStore } from '../state';
import { deriveRelationshipKeys, deriveRoomKeys, type XidKeys } from '../state/identity';
import {
  buildSendTxPcztInWorker,
  frostDeriveAddressFromSkInWorker,
  frostDeriveUfvkInWorker,
  frostDkgPart1InWorker,
  frostDkgPart2InWorker,
  frostDkgPart3InWorker,
  frostSampleFvkSkInWorker,
  frostSignRound1InWorker,
  frostSpendAggregateInWorker,
  frostSpendSignInWorker,
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
  type FrostIo,
  type FrostMine,
  type Seat,
} from './frost-room';
import {
  advanceSign,
  decline,
  proposalsOf,
  seal,
  type Proposal,
  type RoomWallet,
  type SignCalls,
} from './room-sign';
import { readRooms, type PeopleRoom } from './vault';
import { signAndBroadcast } from '../signing/cold-send';
import { frostAirgapSigner } from '../signing/frost-signer';

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
    room: {
      walletId: room.walletId,
      roomId: room.id,
      ceremony: seat.ceremony,
      members: seat.members,
    },
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

const ioFor = (room: PeopleRoom): FrostIo => ({
  post: (bodies, key) =>
    paced(`${room.id}/${key}`, () => peopleCall('frost-post', { roomId: room.id, bodies })),
  keep: (id, patch) => peopleCall<FrostMine>('frost-keep', { roomId: room.id, id, patch }),
  save: save(room),
});

/** the wallet a seat spends from, as its room's payments name it */
export const walletOf = (seat: ZcashWalletJson | undefined): RoomWallet | undefined => {
  const ms = seat?.multisig;
  return ms?.room
    ? { ceremony: ms.room.ceremony, members: ms.room.members, threshold: ms.threshold }
    : undefined;
};

const zcashUrl = () =>
  useStore.getState().networks.networks.zcash.endpoint || 'https://zcash.rotko.net';

/** the signing rounds, bound to this device's share of `seat` */
const signCalls = async (seat: ZcashWalletJson): Promise<SignCalls> => {
  const k = await useStore.getState().keyRing.getMultisigSecrets(seat.vaultId);
  if (!k) {
    throw new Error('this shared wallet is locked');
  }
  return {
    round1: () => frostSignRound1InWorker(k.ephemeralSeed, k.keyPackage),
    sign: (n, h, a, c) => frostSpendSignInWorker(k.ephemeralSeed, k.keyPackage, n, h, a, c),
    aggregate: (h, a, c, sh) =>
      frostSpendAggregateInWorker(seat.multisig!.publicKeyPackage, h, a, c, sh),
    // the shared cold tail: inject, broadcast, and mark what the build spent
    complete: async (p, sigs, cold) =>
      (
        await signAndBroadcast(
          frostAirgapSigner(sigs, { spendIndices: p.si }),
          { pcztHex: p.pczt, spendIndices: p.si, coldSendId: cold },
          { walletId: seat.vaultId, zidecarUrl: zcashUrl(), mainnet: seat.mainnet },
        )
      ).txid,
  };
};

const step = async (walletId: string, roomId: string) => {
  const room = (await readRooms())?.find(r => r.id === roomId && r.walletId === walletId);
  if (!room?.frost) {
    return;
  }
  const me = await roomKeysOf(room);
  const io = ioFor(room);
  const c = ceremonyOf(room.frost.msgs, allowedIn(room, me.pubkey));
  await advance(c, c && room.frost.mine?.[c.id], me, frost, io);
  // payments this device sealed: name the signers, release shares, finish
  const seat = seatOf(useStore.getState().wallets.zcashWallets, room);
  const w = walletOf(seat);
  const open = w
    ? proposalsOf(room.frost.msgs, w).filter(p => !p.sent && room.frost!.mine?.[p.id]?.cm)
    : [];
  if (seat && w && open.length) {
    const calls = await signCalls(seat);
    for (const p of open) {
      await advanceSign(p, w, room.frost.mine?.[p.id], me.pubkey, calls, io);
    }
  }
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
  /** payments proposed from the seat's wallet, oldest first */
  payments: Proposal[];
  /** this device's part in each, by proposal id */
  kept: Record<string, FrostMine>;
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
  const w = walletOf(seat);
  const payments = useMemo(() => (w ? proposalsOf(msgs, w) : []), [msgs, w?.ceremony]);
  const kept = room?.frost?.mine ?? {};
  // the worker is an external system: each new message may let this device do its part
  const live =
    !!room &&
    !!me &&
    ((!!ceremony?.members.includes(me) && !seat) || payments.some(p => !p.sent && kept[p.id]?.cm));
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
  return { me, ceremony, mine: ceremony && kept[ceremony.id], seat, payments, kept };
};

/**
 * Propose a payment from a room's shared wallet: built here from the synced
 * viewing key, said in the room for everyone to review, and sealed by you.
 */
export const proposePayment = async (
  room: PeopleRoom,
  seat: ZcashWalletJson,
  to: string,
  amountZat: string,
) => {
  const w = walletOf(seat)!;
  const u = await buildSendTxPcztInWorker(
    'zcash',
    seat.vaultId,
    zcashUrl(),
    to,
    amountZat,
    '',
    0,
    seat.mainnet,
    seat.orchardFvk,
    true,
  );
  if (!u.alphas.length) {
    throw new Error('the shared wallet has nothing to spend yet');
  }
  const id = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const io = ioFor(room);
  // the room reads lowercase hex and a whole-zatoshi fee: say it that way, or fail here
  const hex = (h: string) => h.toLowerCase();
  const prop = {
    t: 'prop' as const,
    id,
    w: w.ceremony,
    to,
    amt: amountZat,
    fee: BigInt(u.fee).toString(),
    sighash: hex(u.sighash),
    alphas: u.alphas.map(hex),
    si: u.spendIndices,
    pczt: hex(u.pcztHex),
  };
  await io.post(await packFrost(prop), `prop:${id}`);
  if (u.coldSendId) {
    await io.keep(id, { cold: u.coldSendId });
  }
  await seal(prop, await signCalls(seat), io);
  kick(room.walletId, room.id);
};

/** "review and seal", after the review passed and the password was given */
export const sealPayment = async (room: PeopleRoom, seat: ZcashWalletJson, p: Proposal) => {
  await seal(p, await signCalls(seat), ioFor(room));
  kick(room.walletId, room.id);
};

export const declinePayment = (room: PeopleRoom, p: Proposal) => decline(p, ioFor(room));

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
