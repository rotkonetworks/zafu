/**
 * Add a person with v2 cards, over a relay in memory: A shows a card, B
 * answers into its room (sealed to A's pair key), A sees the answer, chooses
 * it after the seal and confirms in the pair room, B sees the confirmation;
 * two answers; an older plain answer; cancel (and a cancel the relay did not
 * take); expiry; the memo path; updates replace by revision, a new name or
 * network waits for a yes, a new pair key is refused; a v1 pair upgrades
 * quietly.
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
import {
  CARD_BODY,
  CARD_TTL_SENT,
  CARD_TTL_SHOWN,
  changed,
  createCards,
  cardRoomId,
  cardRoomSecret,
  readB64Card,
  readNote,
} from './cards';
import { SEALED_BODY } from './card-answer';
import { ephemeralIdentity } from './keys';
import { PAIR_SCOPE } from './pairs';
import { GROUP_ROOM_PLAINTEXT_BYTES } from '@zafu/zirc/room';
import { createPairs } from './pairs';
import { identityOf } from './keys';
import { pairId } from './protocol';
import type { Contact } from '../state/contacts';
import type { PeopleRoom, Thread } from './vault';

const ALICE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const BOB = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const CAROL = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';

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
        caps: Cap.chat | Cap.mailbox | Cap.sealed,
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
  // cached, as the worker's are: a caller that wipes a borrowed key breaks the next one
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

const setup = (aOpts: Partial<CardV2> = {}) => {
  const { transport, state } = board();
  const clock = { t: Date.UTC(2026, 9, 4, 12) };
  const alice = person('wa', ALICE, transport, clock);
  const bob = person('wb', BOB, transport, clock);
  const carol = person('wc', CAROL, transport, clock);
  const aCard = card(ALICE, 0, aOpts);
  const aKey = readB64Card(aCard)!.key;
  const bAnswer = card(BOB, 3, { kind: 'answer', answers: answersOf(aKey), name: 'ken' });
  const bKey = readB64Card(bAnswer)!.key;
  const cAnswer = card(CAROL, 1, { kind: 'answer', answers: answersOf(aKey), name: 'ken' });
  return { alice, bob, carol, aCard, aKey, bAnswer, bKey, cAnswer, clock, state, transport };
};

/** the card room as anyone holding the link reads it */
const asLinkHolder = async (
  svc: ReturnType<typeof person>['service'],
  b64: string,
): Promise<string[]> => {
  const c = readB64Card(b64)!;
  const room: PeopleRoom = {
    id: cardRoomId(c.key),
    walletId: '',
    kind: 'card',
    name: '',
    appScope: PAIR_SCOPE,
    secret: cardRoomSecret(c.key, c.pairKa),
    size: GROUP_ROOM_PLAINTEXT_BYTES,
    relay: c.relay,
    signer: { gen: 0 },
    joined: false,
    createdAt: 0,
  };
  return (await svc.readOnce(room, ephemeralIdentity(), 0)).map(m => m.body);
};

describe('add a person', () => {
  test('show, answer, confirm, done - then chat and an update', async () => {
    const { alice, bob, aCard, aKey, bAnswer, bKey, clock } = setup();
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

    // what a link holder reads in the card's room: a sealed box, never the answer
    const bodies = await asLinkHolder(bob.service, aCard);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.startsWith(SEALED_BODY)).toBe(true);
    expect(bodies[0]).not.toContain(bAnswer);

    // A's pass reads the waiting card's room: the answer opens and verifies,
    // and waits for A; nothing becomes the person by itself
    clock.t += 60_000;
    await alice.service.open();
    const arrived = alice.room(cardRoomId(aKey))!;
    expect(arrived.card).toMatchObject({ state: 'waiting' });
    expect(arrived.card?.answers).toEqual([
      { b64: bAnswer, via: 'relay', sealed: true, at: clock.t },
    ]);
    expect(alice.room(pairId('ken-id'))).toBeUndefined();

    // A compares the seal and chooses: then the pair room and the confirmation
    await alice.op('card-choose', { roomId: cardRoomId(aKey), key: bKey, checked: true });
    const answered = alice.room(cardRoomId(aKey))!;
    expect(answered.card).toMatchObject({
      state: 'answered',
      answer: bAnswer,
      via: 'relay',
      checked: clock.t,
    });
    expect(answered.card?.answers).toBeUndefined();
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
    const update = card(ALICE, 0, {
      kind: 'update',
      revision: 1,
      zcash: '22'.repeat(43),
      caps: Cap.chat | Cap.mailbox,
    });
    await alice.op('card-send', { contactId: 'ken-id', card: update });
    clock.t += 60_000;
    await bob.service.check();
    expect(bob.room(pairId('a-id'))?.pair?.v2?.latest).toBe(update);
    expect(bob.notes(pairId('a-id'))?.at(-1)).toBe('update');
    // the card said it reads sealed answers, the update does not: only the address changed
    expect(changed(readB64Card(aCard)!, readB64Card(update)!)).toEqual(['zcash']);

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
    const { alice, bob, aCard, aKey, bAnswer, bKey, clock, state } = setup();
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
    // a candidate like any other, until A chooses it
    expect(alice.room(cardRoomId(aKey))?.card?.answers).toMatchObject([
      { via: 'memo', sealed: true, height: 3_104_227 },
    ]);
    expect(alice.room(pairId('ken-id'))).toBeUndefined();
    await alice.op('card-choose', { roomId: cardRoomId(aKey), key: bKey });
    expect(alice.room(cardRoomId(aKey))?.card).toMatchObject({
      state: 'answered',
      via: 'memo',
      height: 3_104_227,
    });
    expect(alice.room(cardRoomId(aKey))?.card?.checked).toBeUndefined();
    expect(alice.notes(pairId('ken-id'))).toEqual(['saved-you']);
    clock.t += 60_000;
    await bob.service.check();
    expect(bob.room(pairId('a-id'))?.pair?.v2?.confirmed).toBeGreaterThan(0);
    // a second memo with the same answer does nothing more
    expect(await alice.op('card-memo', { card: bAnswer })).toEqual({ accepted: false });
  });

  test('two answers: both are shown, A chooses one, the other is never taken', async () => {
    const { alice, bob, carol, aCard, aKey, bAnswer, bKey, cAnswer, clock } = setup();
    await alice.op('card-open', { card: aCard, contactId: 'ken-id', gen: 0, j: 0 });
    // carol read the link first and answers as "ken" too
    await carol.op('card-answer', { theirs: aCard, answer: cAnswer, contactId: 'a', gen: 0, j: 1 });
    await bob.op('card-answer', {
      theirs: aCard,
      answer: bAnswer,
      contactId: 'a-id',
      gen: 0,
      j: 3,
    });
    clock.t += 60_000;
    await alice.service.open();
    const answers = alice.room(cardRoomId(aKey))?.card?.answers ?? [];
    expect(answers.map(a => a.b64).sort()).toEqual([bAnswer, cAnswer].sort());
    expect(alice.room(cardRoomId(aKey))?.card?.state).toBe('waiting');

    // the seal shows carol's is not ken's: dismissed, and never offered again
    const cKey = readB64Card(cAnswer)!.key;
    await alice.op('card-dismiss', { roomId: cardRoomId(aKey), key: cKey });
    await alice.op('card-memo', { card: cAnswer });
    expect(alice.room(cardRoomId(aKey))?.card?.answers?.map(a => a.b64)).toEqual([bAnswer]);
    await alice.op('card-choose', { roomId: cardRoomId(aKey), key: bKey, checked: true });
    expect(alice.room(pairId('ken-id'))?.pair?.peer).toBe(bKey);
    // a choice is made once
    await expect(
      alice.op('card-choose', { roomId: cardRoomId(aKey), key: cKey }),
    ).rejects.toThrow();
  });

  test('the choice and a screen retry confirm at once: one confirmation, and it arrives', async () => {
    const { alice, bob, aCard, aKey, bAnswer, bKey, clock, state } = setup();
    await alice.op('card-open', { card: aCard, contactId: 'ken-id', gen: 0, j: 0 });
    await bob.op('card-answer', {
      theirs: aCard,
      answer: bAnswer,
      contactId: 'a-id',
      gen: 0,
      j: 3,
    });
    clock.t += 60_000;
    await alice.service.open();
    // the relay was down for the choice's own confirmation: it is still due
    state.down = true;
    await alice.op('card-choose', { roomId: cardRoomId(aKey), key: bKey });
    state.down = false;
    expect(alice.room(pairId('ken-id'))?.pair?.v2?.confirmDue).toBe(true);
    // the screen retries while the worker does: one goes, the other waits for it
    const api = alice.service.api;
    const send = api.send;
    const sent: string[] = [];
    api.send = (id, body, kind) => (sent.push(body), send(id, body, kind));
    await Promise.all([
      alice.op('card-confirm', { contactId: 'ken-id' }),
      alice.op('card-confirm', { contactId: 'ken-id' }),
    ]);
    api.send = send;
    expect(sent.filter(b => b.startsWith(CARD_BODY))).toHaveLength(1);
    clock.t += 60_000;
    await bob.service.check();
    expect(bob.room(pairId('a-id'))?.pair?.v2?.confirmed).toBeGreaterThan(0);
  });

  test('an older zafu answers plain: still read, marked not sealed', async () => {
    const { alice, bob, aKey, bAnswer, bKey, clock } = setup();
    // a card without Cap.sealed: the answerer posts the answer as it is
    const old = card(ALICE, 0, { caps: Cap.chat | Cap.mailbox });
    await alice.op('card-open', { card: old, contactId: 'ken-id', gen: 0, j: 0 });
    await bob.op('card-answer', { theirs: old, answer: bAnswer, contactId: 'a-id', gen: 0, j: 3 });
    expect(await asLinkHolder(bob.service, old)).toEqual([CARD_BODY + bAnswer]);
    clock.t += 60_000;
    await alice.service.open();
    expect(alice.room(cardRoomId(aKey))?.card?.answers).toMatchObject([
      { b64: bAnswer, sealed: false },
    ]);
    await alice.op('card-choose', { roomId: cardRoomId(aKey), key: bKey });
    expect(alice.room(cardRoomId(aKey))?.card?.state).toBe('answered');
  });

  test('a sealed answer by another key than the one that posted it is not taken', async () => {
    const { alice, bob, aCard, aKey, clock } = setup();
    await alice.op('card-open', { card: aCard, contactId: 'ken-id', gen: 0, j: 0 });
    await bob.op('card-answer', {
      theirs: aCard,
      answer: card(BOB, 5, { kind: 'answer', answers: answersOf(aKey) }),
      contactId: 'y',
      gen: 0,
      j: 6,
    });
    clock.t += 60_000;
    await alice.service.open();
    expect(alice.room(cardRoomId(aKey))?.card?.answers).toBeUndefined();
  });

  test('a cancel the relay did not take stays cancelling, and goes on the next try', async () => {
    const { alice, bob, aCard, aKey, state } = setup();
    await alice.op('card-open', { card: aCard, contactId: 'k', gen: 0, j: 0 });
    state.down = true;
    await expect(alice.op('card-cancel', { roomId: cardRoomId(aKey) })).rejects.toThrow();
    expect(alice.room(cardRoomId(aKey))).toMatchObject({
      joined: false,
      card: { state: 'cancelling' },
    });
    state.down = false;
    // the tap and every window's retry at once: one close goes out
    const api = alice.service.api;
    const send = api.send;
    const sent: string[] = [];
    api.send = (id, body, kind) => (sent.push(body), send(id, body, kind));
    await Promise.all([
      alice.op('card-cancel', { roomId: cardRoomId(aKey) }),
      alice.op('card-cancel', { roomId: cardRoomId(aKey) }),
      alice.op('card-cancel', { roomId: cardRoomId(aKey) }),
    ]);
    api.send = send;
    expect(sent).toHaveLength(1);
    expect(alice.room(cardRoomId(aKey))?.card?.state).toBe('cancelled');
    expect(await bob.op('card-peek', { card: aCard })).toEqual({ known: true, closed: true });
  });

  test('unanswered cards stop being watched: a day when only shown, two weeks once sent', async () => {
    const { alice, aCard, clock } = setup();
    const other = card(ALICE, 1);
    await alice.op('card-open', { card: aCard, contactId: 'k', gen: 0, j: 0 });
    await alice.op('card-open', { card: other, contactId: 'l', gen: 0, j: 1 });
    await alice.op('card-mark', { roomId: cardRoomId(readB64Card(other)!.key), what: 'copied' });
    clock.t += CARD_TTL_SHOWN + 60_000;
    await alice.op('card-expire', {});
    expect(alice.room(cardRoomId(readB64Card(aCard)!.key))).toBeUndefined();
    expect(alice.room(cardRoomId(readB64Card(other)!.key))?.card?.state).toBe('waiting');
    clock.t += CARD_TTL_SENT;
    await alice.op('card-expire', {});
    expect(alice.room(cardRoomId(readB64Card(other)!.key))).toBeUndefined();
  });

  test('a new name or network waits for a yes; a new pair key is never taken', async () => {
    const { alice, bob, aCard, aKey, bAnswer, bKey, clock } = setup();
    await alice.op('card-open', { card: aCard, contactId: 'ken-id', gen: 0, j: 0 });
    await bob.op('card-answer', {
      theirs: aCard,
      answer: bAnswer,
      contactId: 'a-id',
      gen: 0,
      j: 3,
    });
    clock.t += 60_000;
    await alice.service.open();
    await alice.op('card-choose', { roomId: cardRoomId(aKey), key: bKey });
    clock.t += 60_000;
    await bob.service.check();
    const pairB = () => bob.room(pairId('a-id'))?.pair?.v2;

    // a renamed, testnet card: shown, held, not adopted
    const renamed = card(ALICE, 0, { kind: 'update', revision: 1, name: 'mallory', testnet: true });
    await alice.op('card-send', { contactId: 'ken-id', card: renamed });
    clock.t += 60_000;
    await bob.service.check();
    expect(pairB()?.latest).toBe(aCard);
    expect(pairB()?.pending).toBe(renamed);
    expect(bob.notes(pairId('a-id'))?.at(-1)).toBe('update');
    // B says no: kept as it was, and that revision is not asked again
    await bob.op('card-adopt', { contactId: 'a-id', yes: false });
    expect(pairB()).toMatchObject({ latest: aCard, declined: 1 });
    expect(pairB()?.pending).toBeUndefined();

    // a newer one, and B says yes
    const again = card(ALICE, 0, { kind: 'update', revision: 2, name: 'alice' });
    await alice.op('card-send', { contactId: 'ken-id', card: again });
    clock.t += 60_000;
    await bob.service.check();
    expect(pairB()?.pending).toBe(again);
    await bob.op('card-adopt', { contactId: 'a-id', yes: true });
    expect(pairB()?.latest).toBe(again);

    // another pair key under the same relationship key: refused, said so
    const rekeyed = card(ALICE, 0, {
      kind: 'update',
      revision: 3,
      name: 'alice',
      pairKa: 'cd'.repeat(32),
    });
    await alice.op('card-send', { contactId: 'ken-id', card: rekeyed });
    clock.t += 60_000;
    await bob.service.check();
    expect(pairB()?.latest).toBe(again);
    expect(pairB()?.pending).toBeUndefined();
    expect(bob.notes(pairId('a-id'))?.at(-1)).toBe('refused');
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
