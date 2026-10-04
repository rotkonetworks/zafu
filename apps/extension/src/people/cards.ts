/**
 * Contact card v2 on the people relay (design-contact-card-v2, "add a person").
 *
 *   A shows a card (a fresh relationship j). Its ROOM is derived from the card
 *   alone - HKDF(key || pairKa, "zafu-card-room-v2") - so whoever holds the
 *   card can find it, and A can read it before knowing who will answer.
 *   B opens the card, saves A, and posts B's own `answer` card there.
 *   A's pass reads the rooms of its waiting cards, verifies the answer (signed
 *   by the key that posted it, answering A's key), makes the pair room from
 *   both pair keys and posts A's `answer` back into it: the confirmation, so B
 *   can say "ken has your card" only once zafu checked it.
 *   Later cards (`update`, higher revision) travel in the pair room; a
 *   cancelled card gets a signed `close` in its room.
 *
 * The card room lives under the pair scope (`zafu-pair-v1`), which the relay
 * keeps 25 hours like pair rooms; a scope of its own would get the 1 hour
 * default. Whoever holds the card link can read the room, so an answer is as
 * visible to them as the card itself.
 *
 * Every record body is `zp2:card:<base64url signed card>`.
 */

import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { GROUP_ROOM_PLAINTEXT_BYTES, type RoomMessage } from '@zafu/zirc/room';
import { presenceEpoch } from '@zafu/zid';
import {
  answersOf,
  cardB64,
  fromB64url,
  readCardV2,
  signCardV2,
  type CardV2,
} from '@repo/wallet/networks/zcash/card-v2';
import { pairSecret, xidOf, type RelationshipKeys } from '../state/identity';
import { ephemeralIdentity } from './keys';
import { PAIR_SCOPE } from './pairs';
import { pairId } from './protocol';
import { PeopleNeedsRelay, type Gate, type PeopleApi, type PeopleService } from './service';
import type { CardRoom, PeopleRoom, ThreadItem } from './vault';

export const CARD_BODY = 'zp2:card:';
const enc = new TextEncoder();

/** a line zafu writes into a thread about the relationship */
export type Note =
  | { ev: 'saved-you'; via?: 'relay' | 'memo'; height?: number }
  | { ev: 'saved-them' }
  | { ev: 'confirmed' }
  | { ev: 'update'; from: CardV2; to: CardV2 }
  | { ev: 'closed' };

export const cardRoomId = (key: string) => `c:${key}`;

/** the room a card's answer lands in, from the card alone */
export const cardRoomSecret = (key: string, pairKa: string): string =>
  bytesToHex(
    hkdf(
      sha256,
      new Uint8Array([...hexToBytes(key), ...hexToBytes(pairKa)]),
      enc.encode('zafu-card-room-v2'),
      undefined,
      32,
    ),
  );

export const readB64Card = (b64: string | undefined): CardV2 | null => {
  try {
    return b64 ? readCardV2(fromB64url(b64)) : null;
  } catch {
    return null;
  }
};

/** the card a record carries, when it is signed by the key that posted it */
const cardOf = (m: RoomMessage): { card: CardV2; b64: string } | undefined => {
  if (!m.body.startsWith(CARD_BODY)) {
    return undefined;
  }
  const b64 = m.body.slice(CARD_BODY.length);
  const card = readB64Card(b64);
  return card?.key === m.author ? { card, b64 } : undefined;
};

/** the same pair seal on both screens: both keys, in byte order */
export const pairSeal = (a: string, b: string): string =>
  bytesToHex(sha256(enc.encode(`zafu-pair-seal-v1:${[a, b].sort().join(':')}`)));

/** which fields an update changed, as a person reads them */
export const changed = (from: CardV2, to: CardV2) =>
  (['zcash', 'penumbra', 'relay', 'caps'] as const).filter(k => from[k] !== to[k]);

const cardRoom = (
  walletId: string,
  card: CardV2,
  signer: { gen: number; j?: number },
  c: CardRoom,
  joined: boolean,
): PeopleRoom => ({
  id: cardRoomId(card.key),
  walletId,
  kind: 'card',
  name: '',
  appScope: PAIR_SCOPE,
  secret: cardRoomSecret(card.key, card.pairKa),
  size: GROUP_ROOM_PLAINTEXT_BYTES,
  relay: card.relay,
  signer,
  joined,
  createdAt: c.shown,
  card: c,
});

/** the pair room two v2 cards make */
export const pairRoomFromCards = (
  walletId: string,
  contactId: string,
  keys: Pick<RelationshipKeys, 'kaSeed' | 'xid'>,
  signer: { gen: number; j: number },
  theirs: { b64: string; card: CardV2 },
  relay: string,
  at: number,
  extra: NonNullable<PeopleRoom['pair']>['v2'] = {},
): PeopleRoom => ({
  id: pairId(contactId),
  walletId,
  kind: 'pair',
  name: '',
  appScope: PAIR_SCOPE,
  secret: bytesToHex(pairSecret(keys.kaSeed, theirs.card.pairKa, keys.xid, xidOf(theirs.card.key))),
  size: GROUP_ROOM_PLAINTEXT_BYTES,
  relay,
  signer,
  joined: true,
  createdAt: at,
  pair: { personId: contactId, peer: theirs.card.key, v2: { latest: theirs.b64, ...extra } },
});

export interface CardDeps {
  walletId: () => Promise<string | undefined>;
  relKeys: (walletId: string, gen: number, j: number) => Promise<RelationshipKeys>;
  gate: (relay: string) => Promise<Gate>;
  now?: () => number;
}

const minutes = (ms: number) => Math.floor(ms / 60_000);

export const createCards = (deps: CardDeps) => {
  const now = deps.now ?? (() => Date.now());

  const note = (api: PeopleApi, roomId: string, n: Note, key: string) =>
    api.note(roomId, { hash: `n:${key}`, body: JSON.stringify(n), ts: Math.floor(now() / 1000) });

  /**
   * A verified answer to a card you showed: the pair room, your confirmation
   * into it, and the room marked answered. First valid answer wins; the
   * screen saves the person from `card.answer`.
   */
  const accept = async (
    api: PeopleApi,
    room: PeopleRoom,
    answer: { card: CardV2; b64: string },
    via: 'relay' | 'memo',
    height?: number,
  ) => {
    const mine = readB64Card(room.card?.bytes);
    const { j, gen } = room.signer;
    if (!mine || j === undefined || room.card?.state !== 'waiting') {
      return false;
    }
    const keys = await deps.relKeys(room.walletId, gen, j);
    const contactId = room.card.contactId;
    const pair = pairRoomFromCards(
      room.walletId,
      contactId,
      keys,
      { gen, j },
      answer,
      mine.relay,
      now(),
      { confirmDue: true },
    );
    await api.addRoom(pair);
    await note(api, pair.id, { ev: 'saved-you', via, ...(height ? { height } : {}) }, 'saved');
    await api.updateRoom(room.id, r => ({
      ...r,
      joined: false,
      card: {
        ...r.card!,
        state: 'answered',
        answer: answer.b64,
        via,
        at: now(),
        ...(height ? { height } : {}),
      },
    }));
    await confirm(api, contactId).catch(() => undefined);
    return true;
  };

  /** your `answer` to their answer, into the pair room: "you have my card, and I have yours" */
  const confirm = async (api: PeopleApi, contactId: string) => {
    const pair = await api.room(pairId(contactId));
    const theirs = readB64Card(pair?.pair?.v2?.latest);
    const card = (await api.rooms()).find(
      r => r.kind === 'card' && r.card?.mine && r.card.contactId === contactId,
    );
    const mine = readB64Card(card?.card?.bytes);
    if (!pair?.pair?.v2?.confirmDue || !theirs || !mine || pair.signer.j === undefined) {
      return;
    }
    const keys = await deps.relKeys(pair.walletId, pair.signer.gen, pair.signer.j);
    const signed = signCardV2(
      { ...mine, kind: 'answer', answers: answersOf(theirs.key), created: minutes(now()) },
      keys.seed,
    );
    await api.send(pair.id, CARD_BODY + cardB64(signed), 'action');
    await api.updateRoom(pair.id, r => ({
      ...r,
      pair: { ...r.pair!, v2: { ...r.pair!.v2, confirmDue: false } },
    }));
  };

  /** a waiting card's room: the first answer that verifies and answers this card */
  const onCard = async (room: PeopleRoom, records: RoomMessage[], api: PeopleApi) => {
    const me = await api.me(room);
    if (!room.card?.mine || room.card.state !== 'waiting') {
      return undefined;
    }
    const answer = records
      .map(cardOf)
      .find(a => a && a.card.kind === 'answer' && a.card.answers === answersOf(me));
    if (answer) {
      await accept(api, room, answer, 'relay');
    }
    // accept already wrote the room; nothing to patch on top
    return undefined;
  };

  /**
   * A pair room: their confirmation (an `answer` to your card), a newer card
   * (`update`, or the first v2 card from a v1 contact, which upgrades them
   * quietly), or a `close`. Only the peer's own key counts.
   */
  const onPair = async (room: PeopleRoom, records: RoomMessage[], api: PeopleApi) => {
    const peer = room.pair?.peer;
    if (!peer) {
      return undefined;
    }
    const me = await api.me(room);
    const cards = records
      .filter(m => m.author === peer)
      .map(cardOf)
      .filter((c): c is NonNullable<typeof c> => !!c);
    let v2 = { ...room.pair?.v2 };
    for (const c of cards) {
      const latest = readB64Card(v2.latest);
      if (c.card.kind === 'close') {
        if (!v2.closed) {
          v2 = { ...v2, closed: now() };
          await note(api, room.id, { ev: 'closed' }, `closed:${c.card.created}`);
        }
        continue;
      }
      if (c.card.kind === 'answer' && c.card.answers === answersOf(me) && !v2.confirmed) {
        v2 = { ...v2, confirmed: now() };
        await note(api, room.id, { ev: 'confirmed' }, 'confirmed');
      }
      if (!latest || c.card.revision > latest.revision) {
        if (latest && changed(latest, c.card).length) {
          await note(
            api,
            room.id,
            { ev: 'update', from: latest, to: c.card },
            `update:${c.card.revision}`,
          );
        }
        v2 = { ...v2, latest: c.b64 };
      }
    }
    if (JSON.stringify(v2) === JSON.stringify(room.pair?.v2 ?? {})) {
      return undefined;
    }
    return (r: PeopleRoom) => ({ ...r, pair: { ...r.pair!, v2 } });
  };

  /** the founder shows a new card: keep its room, read it from now on */
  const open = async (svc: PeopleService, r: Record<string, unknown>) => {
    const walletId = await deps.walletId();
    const b64 = String(r['card'] ?? '');
    const card = readB64Card(b64);
    const gen = Number(r['gen']);
    const j = Number(r['j']);
    if (!walletId || !card || card.kind !== 'card' || !Number.isInteger(j)) {
      throw new Error('this card could not be read');
    }
    const gate = await deps.gate(card.relay);
    if (gate !== 'on') {
      throw new PeopleNeedsRelay(gate);
    }
    await svc.api.addRoom(
      cardRoom(
        walletId,
        card,
        { gen, j },
        {
          bytes: b64,
          mine: true,
          contactId: String(r['contactId']),
          shown: now(),
          state: 'waiting',
        },
        true,
      ),
    );
    return { id: cardRoomId(card.key) };
  };

  /** what the card's room says about it right now, read with a key used once */
  const peek = async (svc: PeopleService, theirs: CardV2) => {
    const gate = await deps.gate(theirs.relay);
    if (gate !== 'on') {
      return { known: false };
    }
    const room = cardRoom(
      '',
      theirs,
      { gen: 0 },
      { bytes: '', mine: false, contactId: '', shown: now(), state: 'waiting' },
      false,
    );
    // from the minute the card was made: its room holds nothing older
    const since = presenceEpoch(theirs.created * 60);
    const records = await svc.readOnce(room, ephemeralIdentity(), since);
    const own = records.map(cardOf).filter(c => c?.card.key === theirs.key);
    return { known: true, closed: own.some(c => c?.card.kind === 'close') };
  };

  /**
   * The answerer saves the card: the pair room from both pair keys, then
   * your answer into the card's room. Throws `cancelled` when its maker
   * closed it, and the relay's own error when it does not answer (the
   * screen then offers the memo).
   */
  const answer = async (svc: PeopleService, r: Record<string, unknown>) => {
    const walletId = await deps.walletId();
    const theirB64 = String(r['theirs'] ?? '');
    const theirs = readB64Card(theirB64);
    const mineB64 = String(r['answer'] ?? '');
    const mine = readB64Card(mineB64);
    const contactId = String(r['contactId'] ?? '');
    const signer = { gen: Number(r['gen']), j: Number(r['j']) };
    if (!walletId || !theirs || !mine || mine.answers !== answersOf(theirs.key) || !contactId) {
      throw new Error('this card could not be read');
    }
    const gate = await deps.gate(theirs.relay);
    if (gate !== 'on') {
      throw new PeopleNeedsRelay(gate);
    }
    const keys = await deps.relKeys(walletId, signer.gen, signer.j);
    const at = now();
    const pair = pairRoomFromCards(
      walletId,
      contactId,
      keys,
      signer,
      { b64: theirB64, card: theirs },
      theirs.relay,
      at,
    );
    // the pair room first: a memo answer, or a relay that comes back, finds it there
    if (!(await svc.api.room(pair.id))) {
      await svc.api.addRoom(pair);
      await note(svc.api, pair.id, { ev: 'saved-them' }, 'saved');
    }
    if ((await peek(svc, theirs)).closed) {
      await svc.api.updateRoom(pair.id, () => undefined);
      throw new Error('cancelled');
    }
    const room = cardRoom(
      walletId,
      theirs,
      signer,
      {
        bytes: theirB64,
        mine: false,
        contactId,
        shown: at,
        state: 'answered',
        answer: mineB64,
        via: 'relay',
        at,
      },
      false,
    );
    await svc.api.addRoom(room);
    await svc.api.send(room.id, CARD_BODY + mineB64, 'action');
    return { id: pair.id };
  };

  /** an answer that came as a memo: the card it answers, by its hash, then as from the room */
  const memo = async (svc: PeopleService, r: Record<string, unknown>) => {
    const b64 = String(r['card'] ?? '');
    const card = readB64Card(b64);
    if (card?.kind !== 'answer') {
      return { accepted: false };
    }
    const room = (await svc.api.rooms()).find(
      x =>
        x.kind === 'card' &&
        x.card?.mine &&
        x.card.state === 'waiting' &&
        answersOf(readB64Card(x.card.bytes)?.key ?? '00') === card.answers,
    );
    const height = Number(r['height']) || undefined;
    return { accepted: !!room && (await accept(svc.api, room, { card, b64 }, 'memo', height)) };
  };

  /** cancel a card you showed: a signed close into its room, and never watch it again */
  const cancel = async (svc: PeopleService, r: Record<string, unknown>) => {
    const room = await svc.api.room(String(r['roomId'] ?? ''));
    const card = readB64Card(room?.card?.bytes);
    if (!room?.card?.mine || !card || room.signer.j === undefined) {
      throw new Error('that card is not here');
    }
    const keys = await deps.relKeys(room.walletId, room.signer.gen, room.signer.j);
    const close = signCardV2(
      {
        kind: 'close',
        revision: card.revision + 1,
        key: card.key,
        pairKa: card.pairKa,
        relay: card.relay,
        caps: 0,
        created: minutes(now()),
      },
      keys.seed,
    );
    await svc.api.updateRoom(room.id, x => ({
      ...x,
      joined: false,
      card: { ...x.card!, state: 'cancelled', at: now() },
    }));
    await svc.api.send(room.id, CARD_BODY + cardB64(close), 'action').catch(() => undefined);
    return { ok: true };
  };

  /** a card of yours for someone you hold: an update, or a v1 contact's first v2 card */
  const send = async (svc: PeopleService, r: Record<string, unknown>) => {
    const id = pairId(String(r['contactId'] ?? ''));
    const b64 = String(r['card'] ?? '');
    const card = readB64Card(b64);
    const room = await svc.api.room(id);
    if (!card || !room?.joined || card.key !== (await svc.api.me(room))) {
      throw new Error('this card could not be sent');
    }
    await svc.api.send(id, CARD_BODY + b64, 'action');
    return { ok: true };
  };

  const mark = async (svc: PeopleService, r: Record<string, unknown>) => {
    const what = r['what'] === 'shared' ? 'shared' : 'copied';
    await svc.api.updateRoom(String(r['roomId'] ?? ''), x =>
      x.card ? { ...x, card: { ...x.card, [what]: now() } } : x,
    );
    return { ok: true };
  };

  return {
    ops: {
      'card-open': (r: Record<string, unknown>, s: PeopleService) => open(s, r),
      'card-mark': (r: Record<string, unknown>, s: PeopleService) => mark(s, r),
      'card-cancel': (r: Record<string, unknown>, s: PeopleService) => cancel(s, r),
      'card-peek': (r: Record<string, unknown>, s: PeopleService) => {
        const c = readB64Card(String(r['card'] ?? ''));
        return c ? peek(s, c) : Promise.resolve({ known: false });
      },
      'card-answer': (r: Record<string, unknown>, s: PeopleService) => answer(s, r),
      'card-memo': (r: Record<string, unknown>, s: PeopleService) => memo(s, r),
      'card-send': (r: Record<string, unknown>, s: PeopleService) => send(s, r),
      'card-confirm': (r: Record<string, unknown>, s: PeopleService) =>
        confirm(s.api, String(r['contactId'] ?? '')).then(() => ({ ok: true })),
    },
    handlers: { card: onCard, pair: onPair },
  };
};

/** a thread note's text, as the thread shows it */
export const readNote = (item: Pick<ThreadItem, 'kind' | 'body'>): Note | undefined => {
  if (item.kind !== 'note') {
    return undefined;
  }
  try {
    return JSON.parse(item.body) as Note;
  } catch {
    return undefined;
  }
};

/** a note as one short line, for a list row */
export const notePreview = (item: Pick<ThreadItem, 'kind' | 'body'>): string => {
  const n = readNote(item);
  return !n
    ? item.body
    : n.ev === 'saved-you'
      ? 'saved your card'
      : n.ev === 'saved-them'
        ? 'you saved their card'
        : n.ev === 'confirmed'
          ? 'has your card'
          : n.ev === 'update'
            ? 'their card changed'
            : 'closed';
};
