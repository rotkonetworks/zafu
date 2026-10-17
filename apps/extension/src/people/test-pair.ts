/**
 * Two people on a relay in memory, paired with v2 cards: what the people tests
 * that need a real pair room start from.
 */

import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { RelayTransport } from '@zafu/zid';
import {
  CARD_DEFAULT_RELAY,
  Cap,
  answersOf,
  cardB64,
  signCardV2,
  type CardV2,
} from '@repo/wallet/networks/zcash/card-v2';
import { deriveRelationshipKeys } from '../state/identity';
import { chain, createPeopleService, threadKey } from './service';
import { cardRoomId, createCards, readB64Card } from './cards';
import { deliveryOps, onSeen } from './delivery';
import { identityOf } from './keys';
import { createPairPq } from './pair-pq';
import { pairId } from './protocol';
import type { PeopleRoom, Thread } from './vault';

export const ALICE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const BOB = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
export const PQ = Cap.chat | Cap.mailbox | Cap.pq;
export const OLD = Cap.chat | Cap.mailbox;

export const board = () => {
  const coords = new Map<string, Map<string, Uint8Array>>();
  const transport = (): RelayTransport => ({
    putBucket: async r => {
      const k = `${r.appScope}|${r.epoch}|${r.shard}`;
      const c = coords.get(k) ?? new Map();
      r.entries.forEach(e => c.set(bytesToHex(e.tag), e.blob));
      coords.set(k, c);
    },
    getBucket: async r =>
      [...(coords.get(`${r.appScope}|${r.epoch}|${r.shard}`)?.entries() ?? [])].map(([t, b]) => ({
        tag: hexToBytes(t),
        blob: b,
      })),
  });
  return { transport };
};

export const card = (phrase: string, j: number, o: Partial<CardV2> = {}): string => {
  const k = deriveRelationshipKeys(phrase, 0, j);
  return cardB64(
    signCardV2(
      {
        kind: 'card',
        revision: 0,
        key: k.pubkey,
        pairKa: k.kaPublicKey,
        relay: CARD_DEFAULT_RELAY,
        caps: PQ | Cap.sealed,
        created: 29_000_000,
        ...o,
      },
      k.seed,
    ),
  );
};

export const person = (
  walletId: string,
  phrase: string,
  transport: () => RelayTransport,
  clock: { t: number },
  pq = true,
) => {
  let rooms: PeopleRoom[] = [];
  let threads: Record<string, Thread> = {};
  const cache = new Map<string, ReturnType<typeof deriveRelationshipKeys>>();
  const relKeys = async (_w: string, gen: number, j: number) => {
    const k = cache.get(`${gen}/${j}`) ?? deriveRelationshipKeys(phrase, gen, j);
    cache.set(`${gen}/${j}`, k);
    return k;
  };
  const cards = createCards({
    walletId: async () => walletId,
    relKeys,
    gate: async () => 'on',
    now: () => clock.t,
  });
  const service = createPeopleService(
    {
      readRooms: async () => structuredClone(rooms),
      writeRooms: async r => ((rooms = structuredClone(r)), true),
      readThreads: async () => structuredClone(threads),
      writeThreads: async t => ((threads = structuredClone(t)), true),
      walletId: async () => walletId,
      identity: async room => identityOf(await relKeys(walletId, room.signer.gen, room.signer.j!)),
      gate: async () => 'on',
      transport,
      status: () => undefined,
      now: () => clock.t,
    },
    {
      ...cards.handlers,
      pair: chain(
        cards.handlers.pair,
        pq ? createPairPq({ relKeys, now: () => clock.t }) : undefined,
        onSeen,
      ),
    },
  );
  return {
    service,
    relKeys,
    op: (name: keyof typeof cards.ops, r: Record<string, unknown>) => cards.ops[name](r, service),
    receipts: (roomId: string, on: boolean) =>
      deliveryOps['pair-receipts']({ roomId, on }, service),
    thread: (id: string) => threads[threadKey({ walletId, id })],
    room: (id: string) => rooms.find(r => r.id === id),
    lines: (id: string) =>
      threads[threadKey({ walletId, id })]?.items
        .filter(i => i.kind !== 'note')
        .map(i => `${i.mine ? 'me' : 'them'}: ${i.body}${i.status ? ` (${i.status})` : ''}`),
  };
};

/** A shows a card, B answers, A chooses and confirms: the pair room on both sides */
export const paired = async (o: { a?: number; b?: number; bPq?: boolean } = {}) => {
  const { transport } = board();
  const clock = { t: Date.UTC(2026, 9, 16, 12) };
  const alice = person('wa', ALICE, transport, clock);
  const bob = person('wb', BOB, transport, clock, o.bPq ?? true);
  const aCard = card(ALICE, 0, { caps: (o.a ?? PQ) | Cap.sealed });
  const aKey = readB64Card(aCard)!.key;
  const bAnswer = card(BOB, 3, { kind: 'answer', answers: answersOf(aKey), caps: o.b ?? PQ });
  const bKey = readB64Card(bAnswer)!.key;
  await alice.op('card-open', { card: aCard, contactId: 'b', gen: 0, j: 0 });
  await bob.op('card-answer', { theirs: aCard, answer: bAnswer, contactId: 'a', gen: 0, j: 3 });
  clock.t += 60_000;
  await alice.service.open();
  await alice.op('card-choose', { roomId: cardRoomId(aKey), key: bKey, checked: true });
  const classical = alice.room(pairId('b'))!.secret;
  const turns = async (n: number) => {
    for (let i = 0; i < n; i++) {
      clock.t += 60_000;
      await bob.service.check();
      clock.t += 60_000;
      await alice.service.check();
    }
  };
  return { alice, bob, aCard, bAnswer, aKey, bKey, clock, classical, turns };
};
