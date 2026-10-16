/**
 * Pair rooms move to post-quantum over a relay in memory: two new zafus move
 * and chat there, lines written before the move wait and then go; an older
 * peer keeps the first room; an existing pair moves on its first pq update;
 * a box missed past the relay's 48 h is said again; a restore rebuilds the
 * moved room from the box on the contact.
 *
 * @vitest-environment node
 */

import { describe, expect, test } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { RelayTransport } from '@zafu/zid';
import {
  CARD_DEFAULT_RELAY,
  Cap,
  answersOf,
  cardB64,
  fromB64url,
  signCardV2,
  type CardV2,
} from '@repo/wallet/networks/zcash/card-v2';
import { deriveRelationshipKeys, pairSecret, xidOf } from '../state/identity';
import type { Contact } from '../state/contacts';
import { chain, createPeopleService, threadKey } from './service';
import { cardRoomId, createCards, readB64Card } from './cards';
import { identityOf } from './keys';
import { createPairPq, pqSecret } from './pair-pq';
import { pairRoomOf } from './pairs';
import { pairId } from './protocol';
import type { PeopleRoom, Thread } from './vault';

const ALICE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const BOB = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const PQ = Cap.chat | Cap.mailbox | Cap.pq;
const OLD = Cap.chat | Cap.mailbox;

const board = () => {
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

const card = (phrase: string, j: number, o: Partial<CardV2> = {}): string => {
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

const person = (
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
      ),
    },
  );
  return {
    service,
    relKeys,
    op: (name: keyof typeof cards.ops, r: Record<string, unknown>) => cards.ops[name](r, service),
    room: (id: string) => rooms.find(r => r.id === id),
    lines: (id: string) =>
      threads[threadKey({ walletId, id })]?.items
        .filter(i => i.kind !== 'note')
        .map(i => `${i.mine ? 'me' : 'them'}: ${i.body}${i.status ? ` (${i.status})` : ''}`),
  };
};

/** A shows a card, B answers, A chooses and confirms: the pair room on both sides */
const paired = async (o: { a?: number; b?: number; bPq?: boolean } = {}) => {
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

describe('a pair room moves to post-quantum', () => {
  test('two new zafus move, chat there, and a line written before the move waits, then goes', async () => {
    const { alice, bob, classical, turns } = await paired();
    expect(alice.room(pairId('b'))!.pair?.pq?.box).toBeUndefined();
    // not on the first secret: it waits for the move
    expect(await alice.service.say(pairId('b'), 'early')).toBe('checked');
    expect(alice.lines(pairId('b'))).toEqual(['me: early (waiting)']);

    await turns(3);
    const a = alice.room(pairId('b'))!;
    const b = bob.room(pairId('a'))!;
    expect(a.pair?.pq?.box).toBeTruthy();
    expect(a.pair?.pq?.box).toBe(b.pair?.pq?.box);
    expect(a.secret).toBe(b.secret);
    expect(a.secret).not.toBe(classical);
    expect(a.pair?.pq?.ok && b.pair?.pq?.ok).toBe(true);

    await turns(2);
    expect(bob.lines(pairId('a'))).toEqual(['them: early']);
    expect(await bob.service.say(pairId('a'), 'hi')).toBe('sent');
    await turns(2);
    expect(alice.lines(pairId('b'))).toEqual(['me: early', 'them: hi']);
  });

  test('an older peer: the first room stays, chat goes at once', async () => {
    const { alice, bob, classical, turns } = await paired({ b: OLD, bPq: false });
    expect(await alice.service.say(pairId('b'), 'hi')).toBe('sent');
    await turns(3);
    expect(alice.room(pairId('b'))!.secret).toBe(classical);
    expect(alice.room(pairId('b'))!.pair?.pq).toBeUndefined();
    expect(bob.lines(pairId('a'))).toEqual(['them: hi']);
  });

  test('an existing pair moves once both send a pq update', async () => {
    const { alice, bob, classical, turns } = await paired({ a: OLD, b: OLD });
    expect(await alice.service.say(pairId('b'), 'before')).toBe('sent');
    await turns(1);
    await alice.op('card-send', {
      contactId: 'b',
      card: card(ALICE, 0, { kind: 'update', revision: 1, caps: PQ }),
    });
    await bob.op('card-send', {
      contactId: 'a',
      card: card(BOB, 3, { kind: 'update', revision: 1, caps: PQ }),
    });
    await turns(4);
    const a = alice.room(pairId('b'))!;
    expect(a.secret).not.toBe(classical);
    expect(a.secret).toBe(bob.room(pairId('a'))!.secret);
    expect(await alice.service.say(pairId('b'), 'after')).toBe('sent');
    await turns(1);
    expect(bob.lines(pairId('a'))).toEqual(['them: before', 'them: after']);
  });

  test('a box missed past 48 h is said again, and the room still moves', async () => {
    const { alice, bob, aKey, bKey, clock } = await paired();
    const aSeals = xidOf(aKey) < xidOf(bKey);
    const [sealer, opener] = aSeals ? [alice, bob] : [bob, alice];
    const [sRoom, oRoom] = aSeals ? [pairId('b'), pairId('a')] : [pairId('a'), pairId('b')];
    // the opener says its key, the sealer seals and moves; then the opener is away 3 days
    clock.t += 60_000;
    await opener.service.check();
    clock.t += 60_000;
    await sealer.service.check();
    if (!sealer.room(sRoom)!.pair?.pq?.box) {
      // the sealer had not heard the key yet: one more round
      clock.t += 60_000;
      await opener.service.check();
      clock.t += 60_000;
      await sealer.service.check();
    }
    expect(sealer.room(sRoom)!.pair?.pq?.box).toBeTruthy();
    // a line the sealer writes while they are away is still there for them
    clock.t += 30 * 3600_000;
    expect(await sealer.service.say(sRoom, 'while away')).toBe('sent');
    clock.t += 42 * 3600_000;
    await sealer.service.check();
    clock.t += 60_000;
    await opener.service.check();
    expect(opener.room(oRoom)!.secret).toBe(sealer.room(sRoom)!.secret);
    clock.t += 60_000;
    await opener.service.check();
    expect(opener.lines(oRoom)).toEqual(['them: while away']);
    clock.t += 60_000;
    await sealer.service.check();
    expect(sealer.room(sRoom)!.pair?.pq?.ok).toBe(true);
  });

  test('a restore rebuilds the moved room from the box the contact keeps', async () => {
    const { alice, bob, aCard, bAnswer, turns } = await paired();
    await turns(3);
    const a = alice.room(pairId('b'))!;
    const b = bob.room(pairId('a'))!;
    const contact = (id: string, zid: string, pairKa: string, j: number, latest: string): Contact =>
      ({
        id,
        name: '',
        addresses: [],
        createdAt: 0,
        zid,
        pairKa,
        rel: { walletId: 'w', gen: 0, j },
        cardV2: latest,
        pqBox: a.pair!.pq!.box!,
      }) as Contact;
    const ac = readB64Card(aCard)!;
    const bc = readB64Card(bAnswer)!;
    const aKeys = await alice.relKeys('w', 0, 0);
    const bKeys = await bob.relKeys('w', 0, 3);
    expect(pairRoomOf(contact('b', bc.key, bc.pairKa, 0, bAnswer), aKeys, '', 0).secret).toBe(
      a.secret,
    );
    expect(pairRoomOf(contact('a', ac.key, ac.pairKa, 3, aCard), bKeys, '', 0).secret).toBe(
      b.secret,
    );
    // without the box: the first secret, which is not the room any more
    const first = bytesToHex(pairSecret(aKeys.kaSeed, bc.pairKa, aKeys.xid, xidOf(bc.key)));
    expect(first).not.toBe(a.secret);
  });

  test('a box changed in transit, or sealed for another pair, never opens', async () => {
    const { alice, bob, aKey, bKey, turns } = await paired();
    await turns(3);
    const aSeals = xidOf(aKey) < xidOf(bKey);
    const [opener, oj, oKey, sKey] = aSeals ? [bob, 3, bKey, aKey] : [alice, 0, aKey, bKey];
    const room = opener.room(pairId(aSeals ? 'a' : 'b'))!;
    const box = room.pair!.pq!.box!;
    const keys = await opener.relKeys('w', 0, oj);
    const first = '00'.repeat(32);
    expect(() => pqSecret(first, keys, box, oKey, sKey)).not.toThrow();
    const bytes = fromB64url(box);
    bytes[bytes.length - 1]! ^= 1;
    expect(() => pqSecret(first, keys, cardB64(bytes), oKey, sKey)).toThrow();
    // the same box read as if a third key had sealed it
    // a key that would seal to this opener: its XID is the lower one
    const other = [9, 10, 11, 12, 13, 14, 15, 16]
      .map(j => deriveRelationshipKeys(ALICE, 0, j).pubkey)
      .find(k => xidOf(k) < xidOf(oKey))!;
    expect(() => pqSecret(first, keys, box, oKey, other)).toThrow();
  });
});
