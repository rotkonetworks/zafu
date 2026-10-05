/**
 * Shared wallets made inside a room: FROST key making over the room's own
 * records instead of a frostd session with its own code.
 *
 * Why no frostd: frostd exists to carry ceremony messages between devices
 * that share nothing else. A group (or a pair room) already is that: a sealed
 * zirc room only its members can read, where every record is signed by its
 * author's room key. frost-spend already seals each round-2 package to its
 * recipient (X25519 to the round-1 `epk`, bound to the ceremony transcript),
 * so broadcasting packages to the whole room hides each share from the other
 * members as well as from the relay. Nothing is left for frostd to do.
 *
 * One message is one JSON body, deflated and cut into `kc` records (people/door)
 * that share a message id. The records of one ceremony:
 *
 *   start  {id, k, m, label}   whoever taps "make keys together": the threshold
 *                              and the members, fixed from the room's roster
 *   r1     {id, b, x}          each member's signed round-1 broadcast and
 *                              their X-Wing key for this room
 *   sk     {id, s}             the starter: the viewing-key secret, X-Wing
 *                              sealed to each member, bound to this ceremony
 *                              and to that member (never readable by a later
 *                              member of the room or by the relay)
 *   r2     {id, p, h1}         each member's round-2 packages, sealed by frost,
 *                              and a hash of every round-1 record it used
 *   fvk    {id, h}             each member's commitment to the wallet it made:
 *                              a hash of the ceremony, both rounds as it saw
 *                              them, the group key, viewing key and address.
 *                              The viewing key itself is never said: each
 *                              device derives it from the group key and `sk`
 *
 * Every member other than the starter agrees on their own device before it
 * takes part. The latest valid `start` is the ceremony: a new one (another
 * threshold, or "start again without them") replaces the one before, and its
 * records are then ignored. The relay can withhold records (the ceremony
 * waits) but cannot forge one: authors are checked against the members the
 * start names.
 *
 * One record per author, kind and ceremony counts, and a second, different
 * one is never taken in its place: a member who says two different things in
 * one ceremony (two round-one broadcasts, say, to split the others' views)
 * stops it, and so does any member whose round-one or wallet hash differs
 * from this device's. Nothing is saved from a ceremony whose members did not
 * all see the same records.
 */

import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import { openXWing, sealXWing, XWING_LENGTHS } from '@zafu/pq';
import type { RoomMessage } from '@zafu/zirc/room';
import { decodeWire, encodeWire } from './door';
import type { PeopleService } from './service';
import type { PeopleRoom } from './vault';

/** zafu court: an arbiter seat drawn as a member; it answers once the escrow service exists */
export const COURT = 'court';
/** whether zafu court can be chosen: not until its escrow service answers, since its keys could never be made */
export const COURT_OPEN = false;

export interface Deal {
  /** zatoshi, as a decimal string */
  amount: string;
  what: string;
  /** who pays in: whoever proposed it, or the other side */
  payer: 'proposer' | 'other';
}

export type FrostBody =
  | {
      t: 'start';
      id: string;
      k: number;
      m: string[];
      label: string;
      deal?: Deal;
      /** the ceremony this one replaces: another threshold, or someone left out */
      r?: string;
    }
  | { t: 'r1'; id: string; b: string; x: string }
  | { t: 'sk'; id: string; s: Record<string, string> }
  | { t: 'r2'; id: string; p: string[]; h1: string }
  | { t: 'fvk'; id: string; h: string }
  // -- spending from it (people/room-sign) --
  /**
   * a payment from the shared wallet `w`, built by `by`: what every member
   * reviews. Its id is a hash of everything else in it, so no other payment,
   * and nobody else, can ever be said under the same id.
   */
  | {
      t: 'prop';
      id: string;
      w: string;
      by: string;
      to: string;
      amt: string;
      fee: string;
      sighash: string;
      alphas: string[];
      si: number[];
      pczt: string;
    }
  /** "review and seal": this member's round-one commitments, one per spend */
  | { t: 'c'; id: string; c: string[] }
  /** "decline": a message, never a veto */
  | { t: 'no'; id: string }
  /** the proposer: whose commitments sign it */
  | { t: 'set'; id: string; m: string[] }
  /** a signer's round-two shares, one per spend */
  | { t: 's'; id: string; s: string[] }
  /** the proposer: it left, as this transaction */
  | { t: 'sent'; id: string; tx: string };

export interface FrostMsg {
  from: string;
  /** author clock, seconds */
  at: number;
  mid: string;
  body: FrostBody;
}

/** this device's own state in one ceremony; secrets leave once the seat is saved */
export interface FrostMine {
  s1?: string;
  b1?: string;
  sk?: string;
  s2?: string;
  p2?: string[];
  kp?: string;
  pkp?: string;
  seed?: string;
  u?: string;
  a?: string;
  /** the round-one records this device made its round two from, hashed */
  h1?: string;
  /** this device's commitment to the wallet it made (see {@link fvkHash}) */
  fh?: string;
  /** a ceremony someone else started: you agreed to make its keys */
  ok?: boolean;
  saved?: boolean;
  /** a payment: this member's round-one nonces (secret) and commitments, per spend */
  n?: string[];
  cm?: string[];
  /** a payment: the hash of exactly what was reviewed and sealed (see room-sign reviewOf) */
  rv?: string;
  /** a payment, the proposer: whose commitments sign it, as first chosen */
  set?: string[];
  /** the proposer's build handle, to complete what it built */
  cold?: string;
  /** a payment: this member's round-two shares, and the txid it left as */
  sh?: string[];
  tx?: string;
  /** a payment: shares released (the nonces are gone), or declined */
  released?: boolean;
  no?: boolean;
}

interface Part {
  from: string;
  at: number;
  n: number;
  got: Record<number, string>;
}

export interface FrostRoom {
  msgs: FrostMsg[];
  parts?: Record<string, Part>;
  mine?: Record<string, FrostMine>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const HEX = /^[0-9a-f]+$/;
const KEY = /^[0-9a-f]{64}$/;
/** raw bytes per record: base64 of this plus framing stays under a group room's body */
const CHUNK = 2600;
/** ceremonies a room keeps the messages of: the current one and those it replaced */
const KEEP_CEREMONIES = 4;
/** payments a room keeps the messages of */
const KEEP_PROPOSALS = 12;

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

const pipe = async (b: Uint8Array, s: CompressionStream | DecompressionStream) =>
  new Uint8Array(
    await new Response(new Blob([new Uint8Array(b)]).stream().pipeThrough(s)).arrayBuffer(),
  );

/** one message as the records that carry it */
export const packFrost = async (body: FrostBody): Promise<string[]> => {
  const raw = await pipe(enc.encode(JSON.stringify(body)), new CompressionStream('deflate-raw'));
  const mid = bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
  const n = Math.max(1, Math.ceil(raw.length / CHUNK));
  return Array.from({ length: n }, (_, i) =>
    encodeWire({ kind: 'kc', mid, i, n, data: raw.slice(i * CHUNK, (i + 1) * CHUNK) }),
  );
};

const ID = /^[0-9a-f]{32}$/;
const H256 = /^[0-9a-f]{64}$/;
const DIGITS = /^\d{1,16}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** an address as a payment names it: bech32 or base58, nothing else */
const ADDRESS = /^[A-Za-z0-9]{1,1024}$/;
/** an X-Wing public key, hex */
const XWING_HEX = new RegExp(`^[0-9a-f]{${XWING_LENGTHS.publicKey * 2}}$`);

const str = (v: unknown, re = HEX): v is string => typeof v === 'string' && re.test(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const list = (v: unknown, max: number, re = HEX): v is string[] =>
  Array.isArray(v) && v.length >= 1 && v.length <= max && v.every(x => str(x, re));
const keys = (v: unknown, max = 32): v is string[] =>
  list(v, max, KEY) && new Set(v).size === v.length;

const sha = (parts: unknown[]) => bytesToHex(sha256(enc.encode(JSON.stringify(parts))));

/** a payment's id: a hash of all it says, its proposer included */
export const propId = (p: Omit<Extract<FrostBody, { t: 'prop' }>, 'id' | 't'>): string =>
  sha([
    'zafu-frost-prop-v1',
    p.w,
    p.by,
    p.to,
    p.amt,
    p.fee,
    p.sighash,
    p.alphas,
    p.si,
    p.pczt,
  ]).slice(0, 32);

const readDeal = (v: unknown): Deal | undefined => {
  const d = v as Record<string, unknown> | null;
  return d &&
    typeof d === 'object' &&
    str(d['amount'], DIGITS) &&
    text(d['what'], 48) &&
    (d['payer'] === 'proposer' || d['payer'] === 'other')
    ? { amount: d['amount'], what: d['what'], payer: d['payer'] }
    : undefined;
};

/**
 * A body as one we read, or undefined. Every field is checked and the body is
 * built again from the checked fields only, so nothing a peer adds (a label
 * that is not text, a deal amount that is not a number) reaches a screen.
 */
export const readBody = (v: unknown): FrostBody | undefined => {
  const x = v as Record<string, unknown> | null;
  if (!x || typeof x !== 'object' || !str(x['id'], ID)) {
    return undefined;
  }
  const id = x['id'];
  switch (x['t']) {
    case 'start': {
      const m = x['m'];
      const k = x['k'];
      const ok =
        Array.isArray(m) &&
        m.length >= 2 &&
        m.length <= 32 &&
        new Set(m).size === m.length &&
        m.every(p => p === COURT || str(p, KEY)) &&
        typeof k === 'number' &&
        Number.isInteger(k) &&
        k >= 2 &&
        k <= m.length &&
        text(x['label'], 48) &&
        (x['deal'] === undefined || !!readDeal(x['deal'])) &&
        (x['r'] === undefined || str(x['r'], ID));
      if (!ok) {
        return undefined;
      }
      const deal = readDeal(x['deal']);
      return {
        t: 'start',
        id,
        k,
        m: [...(m as string[])],
        label: x['label'] as string,
        ...(deal ? { deal } : {}),
        ...(x['r'] !== undefined ? { r: x['r'] as string } : {}),
      };
    }
    case 'r1':
      return str(x['b']) && str(x['x'], XWING_HEX)
        ? { t: 'r1', id, b: x['b'], x: x['x'] }
        : undefined;
    case 'sk': {
      const s = x['s'] as Record<string, unknown> | null;
      const e = s && typeof s === 'object' && !Array.isArray(s) ? Object.entries(s) : [];
      return e.length >= 1 &&
        e.length <= 32 &&
        e.every(([k, b]) => KEY.test(k) && str(b, B64) && b.length <= 8192)
        ? { t: 'sk', id, s: Object.fromEntries(e) as Record<string, string> }
        : undefined;
    }
    case 'r2':
      return list(x['p'], 32) && str(x['h1'], H256)
        ? { t: 'r2', id, p: [...x['p']], h1: x['h1'] }
        : undefined;
    case 'fvk':
      return str(x['h'], H256) ? { t: 'fvk', id, h: x['h'] } : undefined;
    case 'prop': {
      const si = x['si'];
      if (
        !(
          str(x['w'], ID) &&
          str(x['by'], KEY) &&
          str(x['to'], ADDRESS) &&
          str(x['amt'], DIGITS) &&
          str(x['fee'], DIGITS) &&
          str(x['sighash'], H256) &&
          str(x['pczt']) &&
          list(x['alphas'], 64, H256) &&
          Array.isArray(si) &&
          si.length === x['alphas'].length &&
          si.every(i => Number.isInteger(i) && i >= 0 && i < 1024)
        )
      ) {
        return undefined;
      }
      const body = {
        t: 'prop' as const,
        id,
        w: x['w'],
        by: x['by'],
        to: x['to'],
        amt: x['amt'],
        fee: x['fee'],
        sighash: x['sighash'],
        alphas: [...x['alphas']],
        si: [...(si as number[])],
        pczt: x['pczt'],
      };
      // a payment said under an id that is not its own is not a payment
      return propId(body) === id ? body : undefined;
    }
    case 'c':
      return list(x['c'], 64) ? { t: 'c', id, c: [...x['c']] } : undefined;
    case 's':
      return list(x['s'], 64) ? { t: 's', id, s: [...x['s']] } : undefined;
    case 'set':
      return keys(x['m']) ? { t: 'set', id, m: [...x['m']] } : undefined;
    case 'no':
      return { t: 'no', id };
    case 'sent':
      return str(x['tx'], H256) ? { t: 'sent', id, tx: x['tx'] } : undefined;
    default:
      return undefined;
  }
};

/** the messages a room holds, each read again: one kept from an older build that does not read now is left out */
export const readMsgs = (msgs: FrostMsg[] | undefined): FrostMsg[] =>
  (msgs ?? []).flatMap(m => {
    const body = readBody(m?.body);
    return body && typeof m.from === 'string' && Number.isFinite(m.at) ? [{ ...m, body }] : [];
  });

/**
 * The room handler: fold `kc` records into whole messages. Pieces that have
 * not all arrived wait in `parts`; a pass never writes back what the popup
 * keeps in `mine`.
 */
export const foldFrost = async (
  room: PeopleRoom,
  records: RoomMessage[],
): Promise<((r: PeopleRoom) => PeopleRoom) | undefined> => {
  const pieces = records.flatMap(m => {
    const w = decodeWire(m.body);
    return w?.kind === 'kc' ? [{ m, w }] : [];
  });
  if (!pieces.length) {
    return undefined;
  }
  const touched: Record<string, Part> = {};
  for (const { m, w } of pieces) {
    const key = `${m.author}:${w.mid}`;
    const p = (touched[key] ??= structuredClone(room.frost?.parts?.[key]) ?? {
      from: m.author,
      at: m.ts,
      n: w.n,
      got: {},
    });
    if (p.n === w.n) {
      p.got[w.i] = b64(w.data);
      p.at = Math.min(p.at, m.ts);
    }
  }
  const added: FrostMsg[] = [];
  const done = new Set<string>();
  for (const [key, p] of Object.entries(touched)) {
    if (Object.keys(p.got).length < p.n) {
      continue;
    }
    done.add(key);
    try {
      const raw = Array.from({ length: p.n }, (_, i) => unb64(p.got[i]!));
      const all = new Uint8Array(raw.reduce((n, r) => n + r.length, 0));
      raw.reduce((at, r) => (all.set(r, at), at + r.length), 0);
      const json = dec.decode(await pipe(all, new DecompressionStream('deflate-raw')));
      const body = readBody(JSON.parse(json));
      if (body) {
        added.push({ from: p.from, at: p.at, mid: key.split(':')[1]!, body });
      }
    } catch {
      // a message that does not open is dropped, never half-read
    }
  }
  const stale = Math.floor(Date.now() / 1000) - 2 * 86_400;
  return r => {
    const parts = { ...r.frost?.parts, ...touched };
    for (const [key, p] of Object.entries(parts)) {
      if (done.has(key) || p.at < stale) {
        delete parts[key];
      }
    }
    const msgs = pruneMsgs([...(r.frost?.msgs ?? []), ...added]);
    return { ...r, frost: { ...r.frost, msgs, parts } };
  };
};

/**
 * What a room keeps: the first message per author, kind and ceremony (a
 * repeat of the same message is dropped), and only the last few ceremonies
 * and payments. A later message that differs from the first is never taken
 * in its place: one such copy is kept beside it, so every reader sees that its
 * author said two things (see {@link ceremonyOf} and room-sign proposalsOf).
 */
const pruneMsgs = (all: FrostMsg[]): FrostMsg[] => {
  const seen = new Map<string, string[]>();
  const msgs: FrostMsg[] = [];
  for (const m of readMsgs(all).sort((a, b) => a.at - b.at)) {
    const key = `${m.from}:${m.body.t}:${m.body.id}`;
    const said = JSON.stringify(m.body);
    const before = seen.get(key) ?? [];
    if (before.includes(said) || before.length >= 2) {
      continue;
    }
    seen.set(key, [...before, said]);
    msgs.push(m);
  }
  const last = (t: FrostBody['t'], n: number) =>
    [...new Set(msgs.filter(m => m.body.t === t).map(m => m.body.id))].slice(-n);
  const keep = new Set([...last('start', KEEP_CEREMONIES), ...last('prop', KEEP_PROPOSALS)]);
  return msgs.filter(m => keep.has(m.body.id));
};

// -- what the messages say ----------------------------------------------------

export interface Ceremony {
  id: string;
  by: string;
  k: number;
  members: string[];
  label: string;
  /** seconds: when it started, and its latest record */
  at: number;
  last: number;
  deal?: Deal;
  r1: Map<string, { b: string; x: string }>;
  sk?: Record<string, string>;
  r2: Map<string, { p: string[]; h1: string }>;
  /** each member's commitment to the wallet it made */
  fvk: Map<string, string>;
  /** members who said two different things of one kind in it: it cannot finish */
  split: Set<string>;
}

/** how far a member got: 0 nothing yet, 1 round one, 2 round two, 3 their keys checked */
export const stepOf = (c: Ceremony, member: string): number =>
  c.fvk.has(member) ? 3 : c.r2.has(member) ? 2 : c.r1.has(member) ? 1 : 0;

/**
 * The ceremony a room is in: the latest start by someone allowed, naming only
 * people allowed, and the records its members wrote for it. The first record
 * of each kind per member counts; a second, different one marks that member
 * as split, and the ceremony then stops.
 */
export const ceremonyOf = (
  msgs: FrostMsg[] | undefined,
  allowed: (key: string) => boolean,
): Ceremony | undefined => {
  const all = readMsgs(msgs);
  const starts = all.filter(
    (m): m is FrostMsg & { body: Extract<FrostBody, { t: 'start' }> } =>
      m.body.t === 'start' &&
      m.body.m.includes(m.from) &&
      allowed(m.from) &&
      m.body.m.every(p => p === COURT || allowed(p)),
  );
  const replaced = new Set(starts.map(m => m.body.r));
  const start = starts
    .filter(m => !replaced.has(m.body.id))
    .sort((a, b) => a.at - b.at || (a.mid < b.mid ? -1 : 1))
    .at(-1);
  if (!start) {
    return undefined;
  }
  const s = start.body;
  const c: Ceremony = {
    id: s.id,
    by: start.from,
    k: s.k,
    members: s.m,
    label: s.label,
    at: start.at,
    last: start.at,
    deal: s.deal,
    r1: new Map(),
    r2: new Map(),
    fvk: new Map(),
    split: new Set(),
  };
  const first = new Map<string, string>();
  for (const { from, at, body } of all) {
    if (body.id !== c.id || !c.members.includes(from)) {
      continue;
    }
    if (body.t === 'start' && from !== c.by) {
      continue;
    }
    const key = `${from}:${body.t}`;
    const said = JSON.stringify(body);
    const before = first.get(key);
    if (before !== undefined) {
      if (before !== said) {
        c.split.add(from);
      }
      continue;
    }
    first.set(key, said);
    c.last = Math.max(c.last, at);
    if (body.t === 'r1') {
      c.r1.set(from, { b: body.b, x: body.x });
    } else if (body.t === 'r2') {
      c.r2.set(from, { p: body.p, h1: body.h1 });
    } else if (body.t === 'fvk') {
      c.fvk.set(from, body.h);
    } else if (body.t === 'sk' && from === c.by) {
      c.sk = body.s;
    }
  }
  return c;
};

/** the ceremony's step (1 to 3): the furthest every member has reached, plus one */
export const roundOf = (c: Ceremony): number =>
  Math.min(3, 1 + Math.min(...c.members.map(m => stepOf(c, m))));

/** members still to do the current step */
export const behind = (c: Ceremony): string[] => {
  const low = Math.min(...c.members.map(m => stepOf(c, m)));
  return c.members.filter(m => stepOf(c, m) === low && low < 3);
};

/** how long a ceremony may stand still before the ones behind are shown as missing */
export const MISSING_S = 120;

/** the members holding a ceremony up: behind, and nothing heard for {@link MISSING_S} */
export const missingOf = (c: Ceremony, nowS: number): string[] =>
  nowS - c.last > MISSING_S ? behind(c) : [];

/**
 * "start again without them": new keys for the members left, the threshold
 * kept where it still fits (never below two). Undefined when fewer than two
 * would be left, since one person is not a shared wallet.
 */
export const restartOf = (
  c: Ceremony,
  gone: string[],
): { members: string[]; k: number } | undefined => {
  const members = c.members.filter(m => !gone.includes(m));
  return members.length >= 2
    ? { members, k: Math.max(2, Math.min(c.k, members.length)) }
    : undefined;
};

/**
 * The ceremony cannot finish as it stands: someone said two different
 * things in it, members made round two from different round-one records, or
 * every member checked their keys and they do not match.
 */
export const mismatched = (c: Ceremony): boolean =>
  c.split.size > 0 ||
  new Set([...c.r2.values()].map(r => r.h1)).size > 1 ||
  (c.members.every(m => c.fvk.has(m)) && new Set(c.fvk.values()).size > 1);

/** who a room lets take part: a group's roster, or the two people of a pair room */
export const allowedIn = (room: PeopleRoom, me: string): ((key: string) => boolean) => {
  if (room.kind === 'pair') {
    return k => k === me || k === room.pair?.peer;
  }
  const g = room.group;
  const roster = new Set([g?.founder, ...(g?.members ?? []).map(m => m.key)]);
  return k => roster.has(k);
};

/** a fresh ceremony's start: the members fixed now, the threshold chosen */
export const startBody = (
  members: string[],
  k: number,
  label: string,
  more: { deal?: Deal; replaces?: string } = {},
): FrostBody => ({
  t: 'start',
  id: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
  k,
  m: members,
  label: label.slice(0, 48),
  ...(more.deal ? { deal: more.deal } : {}),
  ...(more.replaces ? { r: more.replaces } : {}),
});

/** the default threshold: a majority */
export const majority = (n: number) => Math.max(2, Math.floor(n / 2) + 1);

/**
 * How `mine` changes: every field is written once and never overwritten, so
 * two windows on the same room cannot post two different round-one secrets.
 * Once the seat is saved its secrets are dropped from the room.
 */
export const keepMine = (cur: FrostMine | undefined, patch: FrostMine): FrostMine => {
  const next: FrostMine = { ...cur };
  for (const [k, v] of Object.entries(patch) as [keyof FrostMine, never][]) {
    if (next[k] === undefined) {
      next[k] = v;
    }
  }
  // a nonce signs once: gone the moment its share leaves
  if (next.released || next.no) {
    delete next.n;
  }
  if (next.saved) {
    delete next.s1;
    delete next.s2;
    delete next.kp;
    delete next.seed;
    delete next.sk;
  }
  return next;
};

// -- one device's part ---------------------------------------------------------

export interface FrostCalls {
  part1(n: number, k: number): Promise<{ secret: string; broadcast: string }>;
  part2(secret: string, broadcasts: string[]): Promise<{ secret: string; peer_packages: string[] }>;
  part3(
    secret: string,
    broadcasts: string[],
    packages: string[],
  ): Promise<{ key_package: string; public_key_package: string; ephemeral_seed: string }>;
  sampleSk(): Promise<string>;
  ufvk(pkp: string, sk: string): Promise<string>;
  address(pkp: string, sk: string): Promise<string>;
}

/** what a finished ceremony leaves on this device */
export interface Seat {
  ceremony: string;
  /** every member's room key: who may propose and seal payments from it */
  members: string[];
  label: string;
  threshold: number;
  maxSigners: number;
  address: string;
  orchardFvk: string;
  keyPackage: string;
  publicKeyPackage: string;
  ephemeralSeed: string;
}

export interface FrostIo {
  /** one message's records; `key` names it (`r1:<ceremony>`), so a caller can pace repeats */
  post(bodies: string[], key: string): Promise<unknown>;
  /** {@link keepMine} applied where the room lives; returns what is kept */
  keep(id: string, patch: FrostMine): Promise<FrostMine>;
  save(seat: Seat): Promise<void>;
}

export interface Me {
  pubkey: string;
  xwingPublicKey: string;
  xwingSeed: Uint8Array;
}

export type FrostStatus = 'idle' | 'waiting' | 'mismatch' | 'done';

/**
 * The round-one records a member makes its round two from, hashed with the
 * ceremony they belong to: every member must arrive at the same one, or some
 * member showed different devices different round-one broadcasts.
 */
export const r1Hash = (c: Ceremony, me: string, own: { b: string; x: string }): string =>
  sha([
    'zafu-frost-r1-v1',
    c.id,
    c.k,
    c.members,
    c.members.map(m => {
      const r = m === me ? own : c.r1.get(m);
      return [m, r?.b ?? '', r?.x ?? ''];
    }),
  ]);

/**
 * What a member commits to once its keys are made: the ceremony, both rounds
 * as this device saw them, the group key, and the viewing key and address it
 * derived. Members compare this, never the viewing key itself.
 */
export const fvkHash = (
  c: Ceremony,
  me: string,
  own: { h1: string; p: string[] },
  pkp: string,
  u: string,
  a: string,
): string =>
  sha([
    'zafu-frost-fvk-v1',
    c.id,
    own.h1,
    c.members.map(m => {
      const r = m === me ? own : c.r2.get(m);
      return [m, r?.h1 ?? '', r?.p ?? []];
    }),
    pkp,
    u,
    a,
  ]);

/** the viewing-key secret's box for one member: bound to this ceremony and to them */
const skAad = (c: Ceremony, member: string) => enc.encode(`zafu-frost-sk-v1:${c.id}:${member}`);

/**
 * Do every step this device can do now, and say where it stands. Safe to call
 * again at any time: what is kept decides what was done, never memory.
 */
export const advance = async (
  c: Ceremony | undefined,
  mine0: FrostMine | undefined,
  me: Me,
  frost: FrostCalls,
  io: FrostIo,
): Promise<FrostStatus> => {
  if (!c?.members.includes(me.pubkey)) {
    return 'idle';
  }
  const others = c.members.filter(m => m !== me.pubkey);
  let mine = mine0 ?? {};
  if (mine.saved) {
    return 'done';
  }
  // keys are made once this member agreed, on this device, to what the start says
  if (c.by !== me.pubkey && !mine.ok) {
    return 'waiting';
  }
  if (mismatched(c)) {
    return 'mismatch';
  }
  const send = async (body: FrostBody) => io.post(await packFrost(body), `${body.t}:${body.id}`);
  // what this device said before and the room does not show: a post that
  // failed, or a record the relay let go. Said again (the caller paces it).
  if (mine.b1 && !c.r1.has(me.pubkey)) {
    await send({ t: 'r1', id: c.id, b: mine.b1, x: me.xwingPublicKey });
  }
  if (mine.p2 && mine.h1 && !c.r2.has(me.pubkey)) {
    await send({ t: 'r2', id: c.id, p: mine.p2, h1: mine.h1 });
  }
  if (mine.fh && !c.fvk.has(me.pubkey)) {
    await send({ t: 'fvk', id: c.id, h: mine.fh });
  }

  if (!mine.b1) {
    const r = await frost.part1(c.members.length, c.k);
    mine = await io.keep(c.id, { s1: r.secret, b1: r.broadcast });
    await send({ t: 'r1', id: c.id, b: mine.b1!, x: me.xwingPublicKey });
  }
  if (!others.every(m => c.r1.has(m))) {
    return 'waiting';
  }
  const theirB = others.map(m => c.r1.get(m)!.b);

  if (c.by === me.pubkey && !c.sk) {
    mine = await io.keep(c.id, { sk: mine.sk ?? (await frost.sampleSk()) });
    const s = Object.fromEntries(
      others.map(m => [
        m,
        b64(sealXWing(hexToBytes(c.r1.get(m)!.x), hexToBytes(mine.sk!), skAad(c, m))),
      ]),
    );
    await send({ t: 'sk', id: c.id, s });
  }
  if (!mine.s2) {
    const h1 = r1Hash(c, me.pubkey, { b: mine.b1!, x: me.xwingPublicKey });
    const r = await frost.part2(mine.s1!, theirB);
    mine = await io.keep(c.id, { s2: r.secret, p2: r.peer_packages, h1 });
    await send({ t: 'r2', id: c.id, p: mine.p2!, h1: mine.h1! });
  }
  // a round two made before its round-one records were hashed cannot be checked
  if (!mine.h1) {
    return 'mismatch';
  }
  let sk = mine.sk;
  if (!sk && c.sk?.[me.pubkey]) {
    try {
      sk = bytesToHex(openXWing(me.xwingSeed, unb64(c.sk[me.pubkey]!), skAad(c, me.pubkey)));
    } catch {
      return 'mismatch';
    }
  }
  if (!sk || !others.every(m => c.r2.has(m))) {
    return 'waiting';
  }
  // every member made its round two from the same round-one records as this device
  if (others.some(m => c.r2.get(m)!.h1 !== mine.h1)) {
    return 'mismatch';
  }
  if (!mine.fh) {
    const r = await frost.part3(
      mine.s2!,
      theirB,
      others.flatMap(m => c.r2.get(m)!.p),
    );
    const u = await frost.ufvk(r.public_key_package, sk);
    const a = await frost.address(r.public_key_package, sk);
    const fh = fvkHash(c, me.pubkey, { h1: mine.h1, p: mine.p2! }, r.public_key_package, u, a);
    mine = await io.keep(c.id, {
      sk,
      kp: r.key_package,
      pkp: r.public_key_package,
      seed: r.ephemeral_seed,
      u,
      a,
      fh,
    });
    await send({ t: 'fvk', id: c.id, h: mine.fh! });
  }
  if (!others.every(m => c.fvk.has(m))) {
    return 'waiting';
  }
  if (others.some(m => c.fvk.get(m) !== mine.fh)) {
    return 'mismatch';
  }
  await io.save({
    ceremony: c.id,
    members: c.members,
    label: c.label,
    threshold: c.k,
    maxSigners: c.members.length,
    address: mine.a!,
    orchardFvk: mine.u!,
    keyPackage: mine.kp!,
    publicKeyPackage: mine.pkp!,
    ephemeralSeed: mine.seed!,
  });
  await io.keep(c.id, { saved: true });
  return 'done';
};

// -- the worker's side ---------------------------------------------------------

export const frostOps = {
  /** a message's records, said in the room by this member */
  'frost-post': async (r: Record<string, unknown>, s: PeopleService) => {
    const bodies = Array.isArray(r['bodies']) ? r['bodies'].map(String) : [];
    if (!bodies.length || !bodies.every(b => b.startsWith('zg1:kc:'))) {
      throw new Error('not a key message');
    }
    for (const b of bodies) {
      await s.api.send(String(r['roomId']), b, 'action');
    }
  },
  /** what this device did in a ceremony, written once per field (see keepMine) */
  'frost-keep': async (r: Record<string, unknown>, s: PeopleService) => {
    const id = String(r['id']);
    let kept: FrostMine | undefined;
    await s.api.updateRoom(String(r['roomId']), x => {
      kept = keepMine(x.frost?.mine?.[id], (r['patch'] ?? {}) as FrostMine);
      return { ...x, frost: { msgs: [], ...x.frost, mine: { ...x.frost?.mine, [id]: kept } } };
    });
    if (!kept) {
      throw new Error('no such room');
    }
    return kept;
  },
};
