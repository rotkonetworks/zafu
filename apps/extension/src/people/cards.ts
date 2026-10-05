/**
 * Contact card v2 on the people relay (design-contact-card-v2, "add a person").
 *
 *   A shows a card (a fresh relationship j). Its ROOM is derived from the card
 *   alone - HKDF(key || pairKa, "zafu-card-room-v2") - so whoever holds the
 *   card can find it, and A can read it before knowing who will answer.
 *   B opens the card, saves A, and posts B's own `answer` card there, sealed
 *   to the card's pair key (people/card-answer) so only A reads it.
 *   A's pass reads the rooms of its waiting cards and keeps every answer that
 *   verifies (signed by the key that posted it, answering A's key). None of
 *   them becomes the person by itself: A's screen shows the seal of each and
 *   A chooses (`card-choose`). Only then is the pair room made from both pair
 *   keys and A's `answer` posted back into it: the confirmation, so B can say
 *   "ken has your card" only once zafu checked it.
 *   Later cards (`update`, higher revision) travel in the pair room; a
 *   cancelled card gets a signed `close` in its room.
 *
 * The card room lives under the pair scope (`zafu-pair-v1`), which the relay
 * keeps 25 hours like pair rooms; a scope of its own would get the 1 hour
 * default. Whoever holds the card link can read the room: an answer is
 * sealed for that reason, and an unanswered card stops being watched after
 * {@link CARD_TTL_SHOWN} (only shown) or {@link CARD_TTL_SENT} (copied or shared).
 *
 * Record bodies are `zp2:card:<base64url signed card>`, or
 * `zp2:card-sealed:<box>` for an answer to a card with `Cap.sealed`.
 */

import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { GROUP_ROOM_PLAINTEXT_BYTES, type RoomMessage } from '@zafu/zirc/room';
import { presenceEpoch } from '@zafu/zid';
import {
  Cap,
  answersOf,
  cardB64,
  fromB64url,
  readCardV2,
  signCardV2,
  type CardV2,
} from '@repo/wallet/networks/zcash/card-v2';
import { wordlists } from 'bip39';
import { openAnswer, sealAnswer, SEALED_BODY } from './card-answer';
import { pairSecret, xidOf, type RelationshipKeys } from '../state/identity';
import { ephemeralIdentity } from './keys';
import { PAIR_SCOPE } from './pairs';
import { pairId } from './protocol';
import { PeopleNeedsRelay, type Gate, type PeopleApi, type PeopleService } from './service';
import type { CardAnswer, CardRoom, PeopleRoom, ThreadItem } from './vault';

export const CARD_BODY = 'zp2:card:';
const enc = new TextEncoder();

/** a line zafu writes into a thread about the relationship */
export type Note =
  | { ev: 'saved-you'; via?: 'relay' | 'memo'; height?: number }
  | { ev: 'saved-them' }
  | { ev: 'confirmed' }
  | { ev: 'update'; from: CardV2; to: CardV2; held?: boolean }
  | { ev: 'refused'; from: CardV2; to: CardV2 }
  | { ev: 'closed' };

/** an unanswered card only shown on screen stops being watched after a day */
export const CARD_TTL_SHOWN = 24 * 3600_000;
/** one copied or shared, two weeks after that */
export const CARD_TTL_SENT = 14 * 24 * 3600_000;

/** the moment a waiting card stops being watched */
export const cardUntil = (c: Pick<CardRoom, 'shown' | 'copied' | 'shared'>): number =>
  Math.max(c.shown + CARD_TTL_SHOWN, Math.max(c.copied ?? 0, c.shared ?? 0) + CARD_TTL_SENT);

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

/** a card in a record body, when it is signed by the key that posted it */
const signedBy = (b64: string, author: string): { card: CardV2; b64: string } | undefined => {
  const card = readB64Card(b64);
  return card?.key === author ? { card, b64 } : undefined;
};

/** the card a plain record carries, when it is signed by the key that posted it */
const cardOf = (m: RoomMessage): { card: CardV2; b64: string } | undefined =>
  m.body.startsWith(CARD_BODY) ? signedBy(m.body.slice(CARD_BODY.length), m.author) : undefined;

/** the same pair seal on both screens: both keys, in byte order */
export const pairSeal = (a: string, b: string): string =>
  bytesToHex(sha256(enc.encode(`zafu-pair-seal-v1:${[a, b].sort().join(':')}`)));

/** words a seal is read by: 6 words of 11 bits, 66 bits of the seal */
export const SEAL_WORDS = 6;

/** the seal as words both people read aloud; the same on both screens */
export const sealWords = (seal: string): string[] => {
  const words = wordlists['english'] ?? [];
  const bits = BigInt(`0x${seal.slice(0, 18)}`); // 72 bits, the top 66 read
  return Array.from({ length: SEAL_WORDS }, (_, i) => {
    const at = BigInt(72 - 11 * (i + 1));
    return words[Number((bits >> at) & 0x7ffn)] ?? '';
  });
};

/** fields an update may change by itself: shown in the thread, kept */
const KEPT = ['zcash', 'penumbra', 'relay', 'caps'] as const;
/** fields that change who or where they are: asked about first */
const ASKED = ['name', 'testnet'] as const;

/** a field as a person reads it: `Cap.sealed` is about the card's own room, not about them */
const field = (c: CardV2, k: (typeof KEPT)[number] | (typeof ASKED)[number] | 'pairKa') =>
  k === 'caps' ? c.caps & ~Cap.sealed : (c[k] ?? '');

/** which fields an update changed, as a person reads them */
export const changed = (from: CardV2, to: CardV2) =>
  ([...KEPT, ...ASKED, 'pairKa'] as const).filter(k => field(from, k) !== field(to, k));

/** what an update does: kept as it is, asked about first, or refused */
export const updateKind = (from: CardV2, to: CardV2): 'kept' | 'asked' | 'refused' => {
  const c = changed(from, to);
  // the pair key makes this room's secret: a card for this relationship never changes it
  return c.includes('pairKa')
    ? 'refused'
    : c.some(k => (ASKED as readonly string[]).includes(k))
      ? 'asked'
      : 'kept';
};

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
   * The answer you chose for a card you showed: the pair room, your
   * confirmation into it, and the room marked answered. The screen saves the
   * person from `card.answer`.
   */
  const accept = async (
    api: PeopleApi,
    room: PeopleRoom,
    answer: { card: CardV2; b64: string },
    via: 'relay' | 'memo',
    height?: number,
    checked?: number,
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
    await api.updateRoom(room.id, r => {
      const { answers: _, ...rest } = r.card!;
      return {
        ...r,
        joined: false,
        card: {
          ...rest,
          state: 'answered',
          answer: answer.b64,
          via,
          at: now(),
          ...(height ? { height } : {}),
          ...(checked ? { checked } : {}),
        },
      };
    });
    await confirm(api, contactId).catch(() => undefined);
    return true;
  };

  /**
   * One run per key at a time: a choice, a cancel and every window's retry
   * can ask at once, and sends racing into one room reach no one. A second
   * caller waits for the run already going.
   */
  const running = new Map<string, Promise<unknown>>();
  const solo = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const have = running.get(key) as Promise<T> | undefined;
    if (have) {
      return have;
    }
    const run = fn().finally(() => running.delete(key));
    running.set(key, run);
    return run;
  };

  const confirm = (api: PeopleApi, contactId: string): Promise<void> =>
    solo(`confirm:${contactId}`, () => confirmOnce(api, contactId));

  /** your `answer` to their answer, into the pair room: "you have my card, and I have yours" */
  const confirmOnce = async (api: PeopleApi, contactId: string) => {
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

  /** the answers so far plus new ones, one per key, never one you dismissed */
  const withAnswers = (c: CardRoom, more: CardAnswer[]): CardAnswer[] | undefined => {
    const have = c.answers ?? [];
    const keyOf = (a: CardAnswer) => readB64Card(a.b64)?.key;
    const known = new Set([...have.map(keyOf), ...(c.dismissed ?? [])]);
    const add = more.filter(a => {
      const k = keyOf(a);
      if (!k || known.has(k)) {
        return false;
      }
      known.add(k);
      return true;
    });
    return add.length ? [...have, ...add] : undefined;
  };

  /**
   * A waiting card's room: every answer that verifies and answers this card,
   * kept as a candidate. A sealed one is opened with the card's own pair
   * secret; a plain one (an older zafu) is kept, marked not sealed.
   */
  const onCard = async (room: PeopleRoom, records: RoomMessage[], api: PeopleApi) => {
    const mine = readB64Card(room.card?.bytes);
    if (!room.card?.mine || room.card.state !== 'waiting' || !mine || room.signer.j === undefined) {
      return undefined;
    }
    const me = await api.me(room);
    const wanted = answersOf(me);
    // the worker keeps relationship keys cached: borrowed here, never wiped
    let kaSeed: Uint8Array | undefined;
    const found: CardAnswer[] = [];
    for (const m of records) {
      if (m.author === me) {
        continue;
      }
      let got: { card: CardV2; b64: string } | undefined;
      let sealed = false;
      if (m.body.startsWith(SEALED_BODY)) {
        kaSeed ??= (await deps.relKeys(room.walletId, room.signer.gen, room.signer.j)).kaSeed;
        const bytes = await openAnswer(mine, kaSeed, m.body);
        got = bytes ? signedBy(cardB64(bytes), m.author) : undefined;
        sealed = true;
      } else {
        got = cardOf(m);
      }
      if (got?.card.kind === 'answer' && got.card.answers === wanted) {
        found.push({ b64: got.b64, via: 'relay', sealed, at: now() });
      }
    }
    const answers = withAnswers(room.card, found);
    return answers
      ? (r: PeopleRoom) => (r.card ? { ...r, card: { ...r.card, answers } } : r)
      : undefined;
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
        const kind = latest ? updateKind(latest, c.card) : 'kept';
        if (latest && kind === 'refused') {
          // never adopted: the pair key is this room's secret
          await note(
            api,
            room.id,
            { ev: 'refused', from: latest, to: c.card },
            `refused:${c.card.revision}`,
          );
          continue;
        }
        if (latest && kind === 'asked') {
          const pending = readB64Card(v2.pending);
          if (
            c.card.revision > (v2.declined ?? -1) &&
            (!pending || c.card.revision > pending.revision)
          ) {
            await note(
              api,
              room.id,
              { ev: 'update', from: latest, to: c.card, held: true },
              `update:${c.card.revision}`,
            );
            v2 = { ...v2, pending: c.b64 };
          }
          continue;
        }
        if (latest && changed(latest, c.card).length) {
          await note(
            api,
            room.id,
            { ev: 'update', from: latest, to: c.card },
            `update:${c.card.revision}`,
          );
        }
        v2 = { ...v2, latest: c.b64 };
        const pending = readB64Card(v2.pending);
        if (pending && pending.revision <= c.card.revision) {
          const { pending: _, ...rest } = v2;
          v2 = rest;
        }
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
    await expire(svc);
    return { id: cardRoomId(card.key) };
  };

  /** unanswered cards past their time: no longer watched, and gone from the list */
  const expire = async (svc: PeopleService) => {
    const at = now();
    for (const x of await svc.api.rooms()) {
      const c = x.card;
      if (
        x.kind === 'card' &&
        c?.mine &&
        c.state === 'waiting' &&
        !c.answers?.length &&
        cardUntil(c) < at
      ) {
        await svc.api.updateRoom(x.id, () => undefined);
      }
    }
    return { ok: true };
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
    // a card that reads sealed answers gets one only its maker opens
    const body =
      theirs.caps & Cap.sealed
        ? await sealAnswer(theirs, fromB64url(mineB64))
        : CARD_BODY + mineB64;
    await svc.api.send(room.id, body, 'action');
    return { id: pair.id };
  };

  /**
   * An answer that came as a memo: the card it answers, by its hash, kept as
   * a candidate like one from the room. A shielded memo is private already.
   */
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
    const add: CardAnswer = {
      b64,
      via: 'memo',
      sealed: true,
      at: now(),
      ...(height ? { height } : {}),
    };
    const answers = room?.card && withAnswers(room.card, [add]);
    if (!room || !answers) {
      return { accepted: false };
    }
    await svc.api.updateRoom(room.id, x => (x.card ? { ...x, card: { ...x.card, answers } } : x));
    return { accepted: true };
  };

  /** the answer you chose (after the seal, or not): it becomes the person */
  const choose = async (svc: PeopleService, r: Record<string, unknown>) => {
    const room = await svc.api.room(String(r['roomId'] ?? ''));
    const key = String(r['key'] ?? '');
    const a = room?.card?.answers?.find(x => readB64Card(x.b64)?.key === key);
    const card = readB64Card(a?.b64);
    if (!room || !a || !card) {
      throw new Error('that answer is not here');
    }
    const checked = r['checked'] === true ? now() : undefined;
    if (!(await accept(svc.api, room, { card, b64: a.b64 }, a.via, a.height, checked))) {
      throw new Error('that card is no longer waiting');
    }
    return { ok: true };
  };

  /** an answer you said is not the person: dropped, and never offered again */
  const dismiss = async (svc: PeopleService, r: Record<string, unknown>) => {
    const key = String(r['key'] ?? '');
    await svc.api.updateRoom(String(r['roomId'] ?? ''), x =>
      x.card
        ? {
            ...x,
            card: {
              ...x.card,
              answers: (x.card.answers ?? []).filter(a => readB64Card(a.b64)?.key !== key),
              dismissed: [...new Set([...(x.card.dismissed ?? []), key])],
            },
          }
        : x,
    );
    return { ok: true };
  };

  /** their held update (a new name or network): take it, or keep what you have */
  const adopt = async (svc: PeopleService, r: Record<string, unknown>) => {
    const id = pairId(String(r['contactId'] ?? ''));
    const yes = r['yes'] === true;
    await svc.api.updateRoom(id, x => {
      const v2 = x.pair?.v2;
      const pending = readB64Card(v2?.pending);
      if (!x.pair || !v2 || !pending) {
        return x;
      }
      const { pending: _, ...rest } = v2;
      return {
        ...x,
        pair: {
          ...x.pair,
          v2: yes ? { ...rest, latest: v2.pending } : { ...rest, declined: pending.revision },
        },
      };
    });
    return { ok: true };
  };

  /**
   * Cancel a card you showed: never watch it again, and a signed close into
   * its room. Until the close has left it stays `cancelling`, and the call
   * fails, so the screen can say so; the next open tries again.
   */
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
    if (room.card.state === 'cancelled' || room.card.state === 'answered') {
      return { ok: true };
    }
    if (room.card.state !== 'cancelling') {
      await svc.api.updateRoom(room.id, x => ({
        ...x,
        joined: false,
        card: { ...x.card!, state: 'cancelling', at: now() },
      }));
    }
    await svc.api.send(room.id, CARD_BODY + cardB64(close), 'action');
    await svc.api.updateRoom(room.id, x => ({
      ...x,
      card: { ...x.card!, state: 'cancelled', at: now() },
    }));
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

  /** the link left the device: when, and it is watched longer from now */
  const mark = async (svc: PeopleService, r: Record<string, unknown>) => {
    const what = r['what'] === 'shared' ? 'shared' : 'copied';
    const room = await svc.api.updateRoom(String(r['roomId'] ?? ''), x =>
      x.card ? { ...x, card: { ...x.card, [what]: now() } } : x,
    );
    if (!room?.card) {
      throw new Error('that card is not here');
    }
    return { ok: true };
  };

  return {
    ops: {
      'card-open': (r: Record<string, unknown>, s: PeopleService) => open(s, r),
      'card-mark': (r: Record<string, unknown>, s: PeopleService) => mark(s, r),
      'card-cancel': (r: Record<string, unknown>, s: PeopleService) =>
        solo(`cancel:${String(r['roomId'] ?? '')}`, () => cancel(s, r)),
      'card-peek': (r: Record<string, unknown>, s: PeopleService) => {
        const c = readB64Card(String(r['card'] ?? ''));
        return c ? peek(s, c) : Promise.resolve({ known: false });
      },
      'card-answer': (r: Record<string, unknown>, s: PeopleService) => answer(s, r),
      'card-memo': (r: Record<string, unknown>, s: PeopleService) => memo(s, r),
      'card-send': (r: Record<string, unknown>, s: PeopleService) => send(s, r),
      'card-confirm': (r: Record<string, unknown>, s: PeopleService) =>
        confirm(s.api, String(r['contactId'] ?? '')).then(() => ({ ok: true })),
      'card-choose': (r: Record<string, unknown>, s: PeopleService) => choose(s, r),
      'card-dismiss': (r: Record<string, unknown>, s: PeopleService) => dismiss(s, r),
      'card-adopt': (r: Record<string, unknown>, s: PeopleService) => adopt(s, r),
      'card-expire': (_: Record<string, unknown>, s: PeopleService) => expire(s),
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
            : n.ev === 'refused'
              ? 'a card zafu did not take'
              : 'closed';
};
