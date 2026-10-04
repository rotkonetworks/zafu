/**
 * Two people who hold each other's cards meet in one pair room with no
 * invite: both derive it from the cards. Text goes both ways, each window on
 * its own shard, and a line signed by a third key is never shown.
 *
 * @vitest-environment node
 */

import { describe, expect, test } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { RelayTransport } from '@zafu/zid';
import { Room } from '@zafu/zirc/room';
import { deriveRelationshipKeys } from '../state/identity';
import type { Contact } from '../state/contacts';
import { createPeopleService, threadKey } from './service';
import { createPairs, pairId, pairShard, PAIR_SCOPE } from './pairs';
import { identityOf } from './keys';
import type { PeopleRoom, Thread } from './vault';

const ALICE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const BOB = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

const board = () => {
  const coords = new Map<string, Map<string, Uint8Array>>();
  const shards = new Set<string>();
  const transport = (): RelayTransport => ({
    putBucket: async r => {
      shards.add(r.shard);
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
  return { transport, shards };
};

/** alice gave bob relationship 0, bob gave alice relationship 3 */
const a0 = deriveRelationshipKeys(ALICE, 0, 0);
const b3 = deriveRelationshipKeys(BOB, 0, 3);
const bobForAlice: Contact = {
  id: 'bob',
  name: 'bob',
  zid: b3.pubkey,
  pairKa: b3.kaPublicKey,
  rel: { walletId: 'wa', gen: 0, j: 0 },
  createdAt: 0,
  addresses: [],
};
const aliceForBob: Contact = {
  id: 'alice',
  name: 'alice',
  zid: a0.pubkey,
  pairKa: a0.kaPublicKey,
  rel: { walletId: 'wb', gen: 0, j: 3 },
  createdAt: 0,
  addresses: [],
};

const person = (
  walletId: string,
  phrase: string,
  contacts: Contact[],
  transport: () => RelayTransport,
  clock: { t: number },
) => {
  let rooms: PeopleRoom[] = [];
  let threads: Record<string, Thread> = {};
  const relKeys = async (_w: string, gen: number, j: number) =>
    deriveRelationshipKeys(phrase, gen, j);
  const pairs = createPairs({
    walletId: async () => walletId,
    contacts: async () => contacts,
    relKeys,
    relay: async () => 'https://relay.example',
    now: () => clock.t,
  });
  const service = createPeopleService({
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
  });
  return {
    service,
    join: (contactId: string) => pairs.ops['pair-join']({ contactId }, service),
    room: (id: string) => rooms.find(r => r.id === id),
    lines: (id: string) =>
      threads[threadKey({ walletId, id })]?.items.map(i => `${i.mine ? 'me' : 'them'}: ${i.body}`),
  };
};

describe('a pair room from two cards', () => {
  test('both derive one room and talk both ways', async () => {
    const { transport, shards } = board();
    const clock = { t: Date.UTC(2026, 9, 3, 12) };
    const alice = person('wa', ALICE, [bobForAlice], transport, clock);
    const bob = person('wb', BOB, [aliceForBob], transport, clock);
    expect(await alice.join('bob')).toMatchObject({ joined: true, id: pairId('bob') });
    expect(await bob.join('alice')).toMatchObject({ joined: true });
    expect(alice.room(pairId('bob'))?.secret).toBe(bob.room(pairId('alice'))?.secret);

    expect(await alice.service.say(pairId('bob'), 'final logo files are up')).toBe('sent');
    clock.t += 6 * 60_000; // the next window: another shard
    await bob.service.open();
    expect(bob.lines(pairId('alice'))).toEqual(['them: final logo files are up']);
    expect(await bob.service.say(pairId('alice'), 'looks great')).toBe('sent');
    await alice.service.check();
    expect(alice.lines(pairId('bob'))).toEqual([
      'me: final logo files are up',
      'them: looks great',
    ]);
    expect(shards.size).toBe(2);
  });

  test('a line from a third key that has the secret is not shown', async () => {
    const { transport } = board();
    const clock = { t: Date.UTC(2026, 9, 3, 12) };
    const alice = person('wa', ALICE, [bobForAlice], transport, clock);
    await alice.join('bob');
    const room = alice.room(pairId('bob'))!;
    const mallory = new Room(identityOf(deriveRelationshipKeys(BOB, 0, 9)), {
      appScope: PAIR_SCOPE,
      roomSecret: hexToBytes(room.secret),
      relay: transport(),
      plaintextBytes: room.size,
      shardFor: pairShard(room.secret),
      now: () => Math.floor(clock.t / 1000),
    });
    await mallory.send('i am bob');
    await alice.service.open();
    expect(alice.lines(pairId('bob'))).toBeUndefined();
  });

  test('no pair room without both cards', async () => {
    const { transport } = board();
    const clock = { t: 0 };
    const half = { ...bobForAlice, pairKa: undefined };
    const alice = person('wa', ALICE, [half], transport, clock);
    expect(await alice.join('bob')).toEqual({ joined: false });
  });
});
