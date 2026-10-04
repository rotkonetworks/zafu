/**
 * Add a person with v2 cards, over a relay in memory: A shows a card, B
 * answers into its room, A verifies and confirms in the pair room, B sees
 * the confirmation; cancel; the memo path; updates replace by revision; a v1
 * pair upgrades quietly.
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
  signCardV2,
  type CardV2,
} from '@repo/wallet/networks/zcash/card-v2';
import { deriveRelationshipKeys } from '../state/identity';
import { createPeopleService, threadKey } from './service';
import { createCards, cardRoomId, readB64Card, readNote } from './cards';
import { createPairs } from './pairs';
import { identityOf } from './keys';
import { pairId } from './protocol';
import type { Contact } from '../state/contacts';
import type { PeopleRoom, Thread } from './vault';

const ALICE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const BOB = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

const board = () => {
  const coords = new Map<string, Map<string, Uint8Array>>();
  const state = { down: false };
  const transport = (): RelayTransport => ({
    putBucket: async r => {
      if (state.down) {
        throw new Error('relay down');
      }
      const k = `${r.appScope}|${r.epoch}|${r.shard}`;
      const c = coords.get(k) ?? new Map();
      r.entries.forEach(e => c.set(bytesToHex(e.tag), e.blob));
      coords.set(k, c);
    },
    getBucket: async r => {
      if (state.down) {
        throw new Error('relay down');
      }
      return [...(coords.get(`${r.appScope}|${r.epoch}|${r.shard}`)?.entries() ?? [])].map(
        ([t, b]) => ({ tag: hexToBytes(t), blob: b }),
      );
    },
  });
  return { transport, state };
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
        zcash: '11'.repeat(43),
        relay: CARD_DEFAULT_RELAY,
        caps: Cap.chat | Cap.mailbox,
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
  contacts: Contact[] = [],
) => {
  let rooms: PeopleRoom[] = [];
  let threads: Record<string, Thread> = {};
  const relKeys = async (_w: string, gen: number, j: number) =>
    deriveRelationshipKeys(phrase, gen, j);
  const cards = createCards({
    walletId: async () => walletId,
    relKeys,
    gate: async () => 'on',
    now: () => clock.t,
  });
  const pairs = createPairs({
    walletId: async () => walletId,
    contacts: async () => contacts,
    relKeys,
    relay: async () => CARD_DEFAULT_RELAY,
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
    cards.handlers,
  );
  const op = (name: keyof typeof cards.ops, r: Record<string, unknown>) =>
    cards.ops[name](r, service);
  return {
    service,
    op,
    join: (contactId: string) => pairs.ops['pair-join']({ contactId }, service),
    room: (id: string) => rooms.find(r => r.id === id),
    notes: (id: string) =>
      threads[threadKey({ walletId, id })]?.items.flatMap(i => readNote(i)?.ev ?? []),
    lines: (id: string) =>
      threads[threadKey({ walletId, id })]?.items
        .filter(i => i.kind !== 'note')
        .map(i => `${i.mine ? 'me' : 'them'}: ${i.body}`),
  };
};

const setup = () => {
  const { transport, state } = board();
  const clock = { t: Date.UTC(2026, 9, 4, 12) };
  const alice = person('wa', ALICE, transport, clock);
  const bob = person('wb', BOB, transport, clock);
  const aCard = card(ALICE, 0);
  const aKey = readB64Card(aCard)!.key;
  const bAnswer = card(BOB, 3, { kind: 'answer', answers: answersOf(aKey), name: 'ken' });
  return { alice, bob, aCard, aKey, bAnswer, clock, state };
};

describe('add a person', () => {
  test('show, answer, confirm, done - then chat and an update', async () => {
    const { alice, bob, aCard, aKey, bAnswer, clock } = setup();
    await alice.op('card-open', { card: aCard, contactId: 'ken-id', gen: 0, j: 0 });
    expect(alice.room(cardRoomId(aKey))?.card?.state).toBe('waiting');

    await bob.op('card-answer', {
      theirs: aCard,
      answer: bAnswer,
      contactId: 'a-id',
      gen: 0,
      j: 3,
    });
    expect(bob.notes(pairId('a-id'))).toEqual(['saved-them']);
    expect(bob.room(pairId('a-id'))?.pair?.v2?.confirmed).toBeUndefined();

    // A's pass reads the waiting card's room: the answer verifies, A confirms
    clock.t += 60_000;
    await alice.service.open();
    const answered = alice.room(cardRoomId(aKey))!;
    expect(answered.card).toMatchObject({ state: 'answered', answer: bAnswer, via: 'relay' });
    expect(answered.joined).toBe(false);
    const aPair = alice.room(pairId('ken-id'))!;
    expect(aPair.pair).toMatchObject({ peer: readB64Card(bAnswer)!.key });
    expect(aPair.pair?.v2?.confirmDue).toBe(false);
    expect(aPair.secret).toBe(bob.room(pairId('a-id'))!.secret);
    expect(alice.notes(pairId('ken-id'))).toEqual(['saved-you']);

    // B: "ken has your card", only once the confirmation verified
    clock.t += 60_000;
    await bob.service.check();
    expect(bob.room(pairId('a-id'))?.pair?.v2?.confirmed).toBeGreaterThan(0);
    expect(bob.notes(pairId('a-id'))).toEqual(['saved-them', 'confirmed']);

    // they chat
    expect(await alice.service.say(pairId('ken-id'), 'hi ken')).toBe('sent');
    clock.t += 6 * 60_000;
    await bob.service.check();
    expect(bob.lines(pairId('a-id'))).toEqual(['them: hi ken']);

    // A gives B a new address: a signed update, revision 1, replaces revision 0
    const update = card(ALICE, 0, { kind: 'update', revision: 1, zcash: '22'.repeat(43) });
    await alice.op('card-send', { contactId: 'ken-id', card: update });
    clock.t += 60_000;
    await bob.service.check();
    expect(bob.room(pairId('a-id'))?.pair?.v2?.latest).toBe(update);
    expect(bob.notes(pairId('a-id'))?.at(-1)).toBe('update');

    // an older revision, signed or not, never replaces a newer one
    await alice.op('card-send', {
      contactId: 'ken-id',
      card: card(ALICE, 0, { kind: 'update', revision: 1 }),
    });
    await alice.op('card-send', {
      contactId: 'ken-id',
      card: card(ALICE, 0, { kind: 'update', revision: 0, zcash: '33'.repeat(43) }),
    });
    clock.t += 60_000;
    await bob.service.check();
    expect(bob.room(pairId('a-id'))?.pair?.v2?.latest).toBe(update);
  });

  test('an answer for another card, or signed by a key that did not post it, is not taken', async () => {
    const { alice, bob, aCard, aKey } = setup();
    await alice.op('card-open', { card: aCard, contactId: 'ken-id', gen: 0, j: 0 });
    const wrong = card(BOB, 4, { kind: 'answer', answers: answersOf('ab'.repeat(32)) });
    await expect(
      bob.op('card-answer', { theirs: aCard, answer: wrong, contactId: 'x', gen: 0, j: 4 }),
    ).rejects.toThrow();
    // posted anyway, by hand, with another key than the card's
    await bob.op('card-answer', {
      theirs: aCard,
      answer: card(BOB, 5, { kind: 'answer', answers: answersOf(aKey) }),
      contactId: 'y',
      gen: 0,
      j: 6, // the room signs with j 6, the card says j 5
    });
    await alice.service.open();
    expect(alice.room(cardRoomId(aKey))?.card?.state).toBe('waiting');
  });

  test('cancel: a signed close, and whoever opens it later sees it was cancelled', async () => {
    const { alice, bob, aCard, aKey, bAnswer } = setup();
    const { id } = (await alice.op('card-open', { card: aCard, contactId: 'k', gen: 0, j: 0 })) as {
      id: string;
    };
    await alice.op('card-cancel', { roomId: id });
    expect(alice.room(cardRoomId(aKey))).toMatchObject({
      joined: false,
      card: { state: 'cancelled' },
    });
    expect(await bob.op('card-peek', { card: aCard })).toEqual({ known: true, closed: true });
    await expect(
      bob.op('card-answer', { theirs: aCard, answer: bAnswer, contactId: 'a-id', gen: 0, j: 3 }),
    ).rejects.toThrow('cancelled');
    expect(bob.room(pairId('a-id'))).toBeUndefined();
  });

  test('the memo path: the relay is down, B answers by memo, A confirms once it is back', async () => {
    const { alice, bob, aCard, aKey, bAnswer, clock, state } = setup();
    await alice.op('card-open', { card: aCard, contactId: 'ken-id', gen: 0, j: 0 });
    state.down = true;
    await expect(
      bob.op('card-answer', { theirs: aCard, answer: bAnswer, contactId: 'a-id', gen: 0, j: 3 }),
    ).rejects.toThrow();
    // B keeps the pair room: a confirmation finds it later
    expect(bob.room(pairId('a-id'))?.pair?.peer).toBe(aKey);
    state.down = false;
    // the memo reaches A's sync
    expect(await alice.op('card-memo', { card: bAnswer, height: 3_104_227 })).toEqual({
      accepted: true,
    });
    expect(alice.room(cardRoomId(aKey))?.card).toMatchObject({ via: 'memo', height: 3_104_227 });
    expect(alice.notes(pairId('ken-id'))).toEqual(['saved-you']);
    clock.t += 60_000;
    await bob.service.check();
    expect(bob.room(pairId('a-id'))?.pair?.v2?.confirmed).toBeGreaterThan(0);
    // a second memo with the same answer does nothing more
    expect(await alice.op('card-memo', { card: bAnswer })).toEqual({ accepted: false });
  });

  test('a v1 pair upgrades quietly on its first v2 card', async () => {
    const { transport } = board();
    const clock = { t: Date.UTC(2026, 9, 4, 12) };
    const a0 = deriveRelationshipKeys(ALICE, 0, 0);
    const b3 = deriveRelationshipKeys(BOB, 0, 3);
    const v1 = (id: string, k: typeof a0, walletId: string, j: number): Contact => ({
      id,
      name: id,
      zid: k.pubkey,
      pairKa: k.kaPublicKey,
      rel: { walletId, gen: 0, j },
      createdAt: 0,
      addresses: [],
    });
    const alice = person('wa', ALICE, transport, clock, [v1('bob', b3, 'wa', 0)]);
    const bob = person('wb', BOB, transport, clock, [v1('alice', a0, 'wb', 3)]);
    await alice.join('bob');
    await bob.join('alice');
    const upgrade = card(BOB, 3, { kind: 'update', revision: 1 });
    await bob.op('card-send', { contactId: 'alice', card: upgrade });
    clock.t += 60_000;
    await alice.service.check();
    expect(alice.room(pairId('bob'))?.pair?.v2?.latest).toBe(upgrade);
    // quietly: no line in the thread
    expect(alice.notes(pairId('bob')) ?? []).toEqual([]);
  });
});
