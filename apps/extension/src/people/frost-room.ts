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
 *                              sealed to each member (never readable by a
 *                              later member of the room or by the relay)
 *   r2     {id, p}             each member's round-2 packages, sealed by frost
 *   fvk    {id, u, a}          each member's viewing key and address: every
 *                              device saves the wallet only when all match
 *
 * The latest valid `start` is the ceremony: a new one (another threshold, or
 * "start again without them") replaces the one before, and its records are
 * then ignored. The relay can withhold records (the ceremony waits) but cannot
 * forge one: authors are checked against the members the start names.
 */

import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { openXWing, sealXWing } from '@zafu/pq';
import type { RoomMessage } from '@zafu/zirc/room';
import { decodeWire, encodeWire } from './door';
import type { PeopleService } from './service';
import type { PeopleRoom } from './vault';

/** zafu court: an arbiter seat drawn as a member; it answers once the escrow service exists */
export const COURT = 'court';

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
  | { t: 'r2'; id: string; p: string[] }
  | { t: 'fvk'; id: string; u: string; a: string };

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
  /** a deal someone else proposed: you agreed to make its keys */
  ok?: boolean;
  saved?: boolean;
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

const str = (v: unknown, re = HEX): v is string => typeof v === 'string' && re.test(v);

/** a body as one we read, or undefined */
const readBody = (v: unknown): FrostBody | undefined => {
  const x = v as Record<string, unknown>;
  if (!x || typeof x !== 'object' || !str(x['id'], /^[0-9a-f]{32}$/)) {
    return undefined;
  }
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
        k <= m.length;
      return ok ? (x as FrostBody) : undefined;
    }
    case 'r1':
      return str(x['b']) && str(x['x']) ? (x as FrostBody) : undefined;
    case 'sk':
      return x['s'] && typeof x['s'] === 'object' ? (x as FrostBody) : undefined;
    case 'r2':
      return Array.isArray(x['p']) && x['p'].every(p => str(p)) ? (x as FrostBody) : undefined;
    case 'fvk':
      return typeof x['u'] === 'string' && typeof x['a'] === 'string'
        ? (x as FrostBody)
        : undefined;
    default:
      return undefined;
  }
};

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
 * What a room keeps: one message per author, kind and ceremony (a repeat
 * replaces the one before), and only the last few ceremonies.
 */
const pruneMsgs = (all: FrostMsg[]): FrostMsg[] => {
  const one = new Map<string, FrostMsg>();
  for (const m of [...all].sort((a, b) => a.at - b.at)) {
    one.set(`${m.from}:${m.body.t}:${m.body.id}`, m);
  }
  const msgs = [...one.values()];
  const keep = new Set(
    msgs
      .filter(m => m.body.t === 'start')
      .slice(-KEEP_CEREMONIES)
      .map(m => m.body.id),
  );
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
  r2: Map<string, string[]>;
  fvk: Map<string, { u: string; a: string }>;
}

/** how far a member got: 0 nothing yet, 1 round one, 2 round two, 3 their keys checked */
export const stepOf = (c: Ceremony, member: string): number =>
  c.fvk.has(member) ? 3 : c.r2.has(member) ? 2 : c.r1.has(member) ? 1 : 0;

/**
 * The ceremony a room is in: the latest start by someone allowed, naming only
 * people allowed, and the records its members wrote for it.
 */
export const ceremonyOf = (
  msgs: FrostMsg[] | undefined,
  allowed: (key: string) => boolean,
): Ceremony | undefined => {
  const starts = (msgs ?? []).filter(
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
  };
  for (const { from, at, body } of msgs ?? []) {
    if (body.id !== c.id || !c.members.includes(from)) {
      continue;
    }
    c.last = Math.max(c.last, at);
    if (body.t === 'r1') {
      c.r1.set(from, { b: body.b, x: body.x });
    } else if (body.t === 'r2') {
      c.r2.set(from, body.p);
    } else if (body.t === 'fvk') {
      c.fvk.set(from, { u: body.u, a: body.a });
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

/** every member checked their keys, and they do not match */
export const mismatched = (c: Ceremony): boolean =>
  c.members.every(m => c.fvk.has(m)) && new Set([...c.fvk.values()].map(f => f.u + f.a)).size > 1;

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
  // a deal's keys are made once the other side agrees to its terms
  if (c.deal && c.by !== me.pubkey && !mine.ok) {
    return 'waiting';
  }
  const send = async (body: FrostBody) => io.post(await packFrost(body), `${body.t}:${body.id}`);
  // what this device said before and the room does not show: a post that
  // failed, or a record the relay let go. Said again (the caller paces it).
  if (mine.b1 && !c.r1.has(me.pubkey)) {
    await send({ t: 'r1', id: c.id, b: mine.b1, x: me.xwingPublicKey });
  }
  if (mine.p2 && !c.r2.has(me.pubkey)) {
    await send({ t: 'r2', id: c.id, p: mine.p2 });
  }
  if (mine.u && mine.a && !c.fvk.has(me.pubkey)) {
    await send({ t: 'fvk', id: c.id, u: mine.u, a: mine.a });
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
      others.map(m => [m, b64(sealXWing(hexToBytes(c.r1.get(m)!.x), hexToBytes(mine.sk!)))]),
    );
    await send({ t: 'sk', id: c.id, s });
  }
  if (!mine.s2) {
    const r = await frost.part2(mine.s1!, theirB);
    mine = await io.keep(c.id, { s2: r.secret, p2: r.peer_packages });
    await send({ t: 'r2', id: c.id, p: mine.p2! });
  }
  let sk = mine.sk;
  if (!sk && c.sk?.[me.pubkey]) {
    try {
      sk = bytesToHex(openXWing(me.xwingSeed, unb64(c.sk[me.pubkey]!)));
    } catch {
      return 'mismatch';
    }
  }
  if (!sk || !others.every(m => c.r2.has(m))) {
    return 'waiting';
  }
  if (!mine.u) {
    const r = await frost.part3(
      mine.s2!,
      theirB,
      others.flatMap(m => c.r2.get(m)!),
    );
    const u = await frost.ufvk(r.public_key_package, sk);
    const a = await frost.address(r.public_key_package, sk);
    mine = await io.keep(c.id, {
      sk,
      kp: r.key_package,
      pkp: r.public_key_package,
      seed: r.ephemeral_seed,
      u,
      a,
    });
    await send({ t: 'fvk', id: c.id, u: mine.u!, a: mine.a! });
  }
  if (!others.every(m => c.fvk.has(m))) {
    return 'waiting';
  }
  if (others.some(m => c.fvk.get(m)!.u !== mine.u || c.fvk.get(m)!.a !== mine.a)) {
    return 'mismatch';
  }
  await io.save({
    ceremony: c.id,
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
