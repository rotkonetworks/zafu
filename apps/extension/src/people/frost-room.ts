/**
 * Shared wallets made inside a room: FROST key making over the room's own
 * records, with no leader and no starter (zafu #110).
 *
 * Why no frostd: frostd exists to carry ceremony messages between devices
 * that share nothing else. A group already is that: a sealed zirc room only
 * its members can read, where every record is signed by its author's room
 * key. frost-spend seals each round-2 package to its recipient, so
 * broadcasting packages to the whole room hides each share from the other
 * members as well as from the relay.
 *
 * One message is one JSON body, deflated and cut into `kc` records (people/
 * door) that share a message id. Version 2 bodies (`v: 2`) are the leaderless
 * objects of `@zafu/zirc/leaderless`, carried as JSON with every field the
 * canonical encoding hashes:
 *
 *   g     {g}               a wallet's genesis, proposed from a chat
 *   i     {i, sig}          an invite, signed by its owner
 *   join  {j, js, os?}      a join, signed by the joiner and then its owner
 *   rs    {r, k, sig}       member k signs roster r: that is its "agree"
 *   rot   {rot, r, k, sig, box?}  member k signs a rotation; the proposer's
 *                           copy carries the new secret sealed to each member
 *   all   {items}           a bundle of the above, said again for newcomers
 *   r1    {b, x, c}         round one, an X-Wing key, and c_i = H(R, i, s_i)
 *   r2    {p, s, h1}        round-two packages, s_i sealed to each member, and
 *                           h1 = H(every round-one record it used)
 *   fvk   {h}               a hash of R, both rounds, the group key, the
 *                           viewing key and the address
 *
 * A key setup's context is its roster's id: it runs once that roster binds
 * (every member signed it, see people/lx). The viewing-key secret is
 * sk = H("zafu-fvk-v1" ‖ R ‖ s_1 ‖ … ‖ s_n): each member committed to its s_i
 * before anyone revealed one, so nobody chooses it. The wallet exists only
 * when all n fvk hashes match; a member who says two different things in one
 * setup, reveals an s_i that does not open its commitment, or ends with
 * another wallet stops it, and nothing is saved. No rule here reads "first",
 * "latest" or record order.
 *
 * Records an older zafu said (a `start`, an `sk`, round records without a
 * version) are read only to say that the other side needs a newer zafu.
 * Wallets made that way keep signing: a payment reads the saved seat.
 */

import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import { openXWing, sealXWing, XWING_LENGTHS } from '@zafu/pq';
import {
  commitOf,
  fvkHash,
  genesisId,
  h1Of,
  inviteId,
  r1Id,
  r2Id,
  revealAad,
  rosterId,
  rotateId,
  skOf,
  sortKeys,
  type Genesis,
  type Invite,
  type Join,
  type Roster,
  type Rotate,
} from '@zafu/zirc/leaderless';
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

/** the leaderless objects, as the room carries them */
export type LxBody =
  | { t: 'g'; v: 2; id: string; g: Genesis }
  | { t: 'i'; v: 2; id: string; i: Invite; sig: string }
  /** `jm`: the joiner's proof to the owner that its door run let it in (lx joinMac) */
  | { t: 'join'; v: 2; id: string; j: Join; js: string; jm?: string; os?: string }
  | { t: 'rs'; v: 2; id: string; r: Roster; k: string; sig: string }
  | {
      t: 'rot';
      v: 2;
      id: string;
      rot: Rotate;
      r: Roster;
      k: string;
      sig: string;
      box?: Record<string, string>;
    };

export type FrostBody =
  | LxBody
  | { t: 'all'; v: 2; id: string; items: LxBody[] }
  | { t: 'r1'; v: 2; id: string; b: string; x: string; c: string }
  | { t: 'r2'; v: 2; id: string; p: string[]; s: string[]; h1: string }
  | { t: 'fvk'; v: 2; id: string; h: string }
  /** a key-setup record an older zafu said: read only to say so */
  | { t: 'old'; id: string }
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

/** this device's own state in one setup or payment; secrets leave once the seat is saved */
export interface FrostMine {
  s1?: string;
  b1?: string;
  /** s_i, this member's share of the viewing-key secret, and the boxes it went out in */
  si?: string;
  bx?: string[];
  s2?: string;
  p2?: string[];
  kp?: string;
  pkp?: string;
  seed?: string;
  u?: string;
  a?: string;
  /** the round-one records this device made its round two from, hashed */
  h1?: string;
  /** this device's commitment to the wallet it made (objects fvkHash) */
  fh?: string;
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
const HEX = /^(?:[0-9a-f]{2})+$/;
const KEY = /^[0-9a-f]{64}$/;
const SIG = /^[0-9a-f]{128}$/;
/** raw bytes per record: base64 of this plus framing stays under a group room's body */
const CHUNK = 2600;
/** key setups a room keeps the round records of */
const KEEP_SETUPS = 4;
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
/** a payment's wallet: an older setup's 16-byte id, or a roster's 32 */
const WALLET = /^[0-9a-f]{32}(?:[0-9a-f]{32})?$/;
const H256 = KEY;
const DIGITS = /^\d{1,16}$/;
/** an address as a payment names it: bech32 or base58, nothing else */
const ADDRESS = /^[A-Za-z0-9]{1,1024}$/;
/** an X-Wing public key, hex */
const XWING_HEX = new RegExp(`^[0-9a-f]{${XWING_LENGTHS.publicKey * 2}}$`);

const str = (v: unknown, re = HEX): v is string => typeof v === 'string' && re.test(v);
const list = (v: unknown, max: number, re = HEX): v is string[] =>
  Array.isArray(v) && v.length >= 1 && v.length <= max && v.every(x => str(x, re));
const keys = (v: unknown, max = 32): v is string[] =>
  list(v, max, KEY) && new Set(v).size === v.length;
const int = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

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

/** an id that is a hash of the object it names, or nothing */
const named = <T>(id: unknown, v: T, idOf: (v: T) => string): boolean => {
  try {
    return id === idOf(v);
  } catch {
    return false;
  }
};

const readGenesis = (v: unknown): Genesis | undefined => {
  const g = obj(v);
  return g &&
    (g['purpose'] === 'chat' || g['purpose'] === 'wallet') &&
    int(g['t'], 32) &&
    int(g['n'], 32) &&
    str(g['salt'], ID) &&
    str(g['creator'], KEY)
    ? { purpose: g['purpose'], t: g['t'], n: g['n'], salt: g['salt'], creator: g['creator'] }
    : undefined;
};

const readRoster = (v: unknown): Roster | undefined => {
  const r = obj(v);
  return r && str(r['G'], KEY) && keys(r['members'])
    ? { G: r['G'], members: [...r['members']] }
    : undefined;
};

/** a leaderless object, built again from its checked fields, under its own id */
const readLx = (x: Record<string, unknown>): LxBody | undefined => {
  const id = x['id'];
  switch (x['t']) {
    case 'g': {
      const g = readGenesis(x['g']);
      return g && g.purpose === 'wallet' && named(id, g, genesisId)
        ? { t: 'g', v: 2, id: id as string, g }
        : undefined;
    }
    case 'i': {
      const i = obj(x['i']);
      const inv = i &&
        str(i['G'], KEY) &&
        str(i['owner'], KEY) &&
        int(i['plate'], 0xffff_ffff) &&
        str(i['salt'], ID) &&
        int(i['expiry'], 0xffff_ffff) && {
          G: i['G'],
          owner: i['owner'],
          plate: i['plate'],
          salt: i['salt'],
          expiry: i['expiry'],
        };
      return inv && str(x['sig'], SIG) && named(id, inv, inviteId)
        ? { t: 'i', v: 2, id: id as string, i: inv, sig: x['sig'] }
        : undefined;
    }
    case 'join': {
      const j = obj(x['j']);
      const jn = j &&
        str(j['I'], KEY) &&
        str(j['joiner'], KEY) &&
        str(j['th'], KEY) && { I: j['I'], joiner: j['joiner'], th: j['th'] };
      const opt = (k: 'os' | 'jm', re: RegExp) =>
        x[k] === undefined || str(x[k], re) ? {} : undefined;
      return jn && id === jn.I && str(x['js'], SIG) && opt('os', SIG) && opt('jm', KEY)
        ? {
            t: 'join',
            v: 2,
            id: jn.I,
            j: jn,
            js: x['js'],
            ...(x['jm'] !== undefined ? { jm: x['jm'] as string } : {}),
            ...(x['os'] !== undefined ? { os: x['os'] as string } : {}),
          }
        : undefined;
    }
    case 'rs': {
      const r = readRoster(x['r']);
      return r && str(x['k'], KEY) && str(x['sig'], SIG) && named(id, r, rosterId)
        ? { t: 'rs', v: 2, id: id as string, r, k: x['k'], sig: x['sig'] }
        : undefined;
    }
    case 'rot': {
      const rot = obj(x['rot']);
      const rt = rot &&
        str(rot['R'], KEY) &&
        str(rot['from'], KEY) &&
        str(rot['to'], KEY) && { R: rot['R'], from: rot['from'], to: rot['to'] };
      const r = readRoster(x['r']);
      const box = obj(x['box']);
      const boxes = box ? Object.entries(box) : [];
      const boxOk =
        x['box'] === undefined ||
        (boxes.length <= 32 && boxes.every(([k, b]) => KEY.test(k) && str(b) && b.length <= 4096));
      return rt &&
        r &&
        rt.R === rosterId(r) &&
        str(x['k'], KEY) &&
        str(x['sig'], SIG) &&
        boxOk &&
        named(id, rt, rotateId)
        ? {
            t: 'rot',
            v: 2,
            id: id as string,
            rot: rt,
            r,
            k: x['k'],
            sig: x['sig'],
            ...(box ? { box: Object.fromEntries(boxes) as Record<string, string> } : {}),
          }
        : undefined;
    }
    default:
      return undefined;
  }
};

/**
 * A body as one we read, or undefined. Every field is checked and the body is
 * built again from the checked fields only, so nothing a peer adds reaches a
 * screen; an object is read only under its own content id.
 */
export const readBody = (v: unknown): FrostBody | undefined => {
  const x = obj(v);
  if (!x) {
    return undefined;
  }
  if (x['v'] === 2) {
    const id = x['id'];
    switch (x['t']) {
      case 'all': {
        const items = Array.isArray(x['items']) ? x['items'].slice(0, 400) : [];
        const read = items.flatMap(i => {
          const o = obj(i);
          const b = o && o['v'] === 2 ? readLx(o) : undefined;
          return b ? [b] : [];
        });
        return str(id, ID) && read.length ? { t: 'all', v: 2, id, items: read } : undefined;
      }
      case 'r1':
        return str(id, KEY) && str(x['b']) && str(x['x'], XWING_HEX) && str(x['c'], KEY)
          ? { t: 'r1', v: 2, id, b: x['b'], x: x['x'], c: x['c'] }
          : undefined;
      case 'r2': {
        const s = x['s'];
        return str(id, KEY) &&
          list(x['p'], 32) &&
          Array.isArray(s) &&
          s.length >= 2 &&
          s.length <= 32 &&
          s.every(b => b === '' || (str(b) && b.length <= 8192)) &&
          str(x['h1'], KEY)
          ? { t: 'r2', v: 2, id, p: [...x['p']], s: [...(s as string[])], h1: x['h1'] }
          : undefined;
      }
      case 'fvk':
        return str(id, KEY) && str(x['h'], KEY) ? { t: 'fvk', v: 2, id, h: x['h'] } : undefined;
      default:
        return readLx(x);
    }
  }
  const id = x['id'];
  if (!str(id, ID)) {
    return undefined;
  }
  switch (x['t']) {
    case 'old':
    case 'start':
    case 'sk':
    case 'r1':
    case 'r2':
    case 'fvk':
      return { t: 'old', id };
    case 'prop': {
      const si = x['si'];
      if (
        !(
          str(x['w'], WALLET) &&
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
 * The room handler: fold `kc` records into whole messages, a bundle into the
 * objects it carries. Pieces that have not all arrived wait in `parts`; a
 * pass never writes back what the popup keeps in `mine`.
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
      const mid = key.split(':')[1]!;
      if (body?.t === 'all') {
        added.push(...body.items.map(b => ({ from: p.from, at: p.at, mid, body: b })));
      } else if (body) {
        added.push({ from: p.from, at: p.at, mid, body });
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

/** what keeps one copy of a message: an object is itself; a round record is its author's word */
const slotOf = (m: FrostMsg): string => {
  const b = m.body;
  switch (b.t) {
    case 'g':
    case 'i':
      return `${b.t}:${b.id}`;
    case 'join':
      return `join:${b.id}:${b.j.joiner}:${b.j.th}:${b.os ? 'both' : 'half'}`;
    case 'rs':
    case 'rot':
      return `${b.t}:${b.id}:${b.k}`;
    default:
      return `${m.from}:${b.t}:${b.id}`;
  }
};

/**
 * What a room keeps. Every leaderless object stays: seats rest on them, and a
 * newcomer is shown them again. A round or payment record a member said
 * twice, differently, is kept beside the first (at most two), so every
 * reader sees that its author said two things; and only the last few key
 * setups and payments keep their round records. Keeping is storage, never
 * a rule: a setup whose records were let go waits, it never decides.
 */
const pruneMsgs = (all: FrostMsg[]): FrostMsg[] => {
  const seen = new Map<string, string[]>();
  const msgs: FrostMsg[] = [];
  for (const m of readMsgs(all).sort((a, b) => a.at - b.at)) {
    const key = slotOf(m);
    const said = JSON.stringify(m.body);
    const before = seen.get(key) ?? [];
    if (before.includes(said) || before.length >= 2) {
      continue;
    }
    seen.set(key, [...before, said]);
    msgs.push(m);
  }
  const last = (ts: FrostBody['t'][], n: number) =>
    [...new Set(msgs.filter(m => ts.includes(m.body.t)).map(m => m.body.id))].slice(-n);
  const keep = new Set([
    ...last(['r1', 'r2', 'fvk'], KEEP_SETUPS),
    ...last(['prop'], KEEP_PROPOSALS),
    ...last(['old'], 1),
  ]);
  const lx = new Set<FrostBody['t']>(['g', 'i', 'join', 'rs', 'rot']);
  return msgs.filter(m => lx.has(m.body.t) || keep.has(m.body.id));
};

// -- one key setup -------------------------------------------------------------

export interface R1Rec {
  b: string;
  x: string;
  c: string;
  /** its id (objects r1Id) */
  id: string;
}
export interface R2Rec {
  p: string[];
  s: string[];
  h1: string;
  id: string;
}

/** one wallet being made: a roster for a wallet genesis, and its rounds */
export interface Keygen {
  /** the roster's id: the setup's context */
  id: string;
  G: Genesis;
  k: number;
  /** the roster, in its order */
  members: string[];
  /** who proposed the wallet (its genesis creator) */
  by: string;
  /** seconds: when it was proposed, and its latest record */
  at: number;
  last: number;
  /** members whose signature on the roster holds: their "agree" */
  agreed: Set<string>;
  /** the room's own wallet, made by codes: typing the code was the yes, nobody is asked */
  byCode: boolean;
  bound: boolean;
  /** another roster for the same wallet has signatures too: it waits until one is settled */
  rival: boolean;
  r1: Map<string, R1Rec>;
  r2: Map<string, R2Rec>;
  /** each member's commitment to the wallet it made */
  fvk: Map<string, string>;
  /** members who said two different things of one kind in it: it cannot finish */
  split: Set<string>;
}

/** the rounds said for one roster, read from its members only; a second, different record marks its author */
export const roundsOf = (
  msgs: FrostMsg[] | undefined,
  R: string,
  members: string[],
): Pick<Keygen, 'r1' | 'r2' | 'fvk' | 'split' | 'last'> => {
  const out = {
    r1: new Map<string, R1Rec>(),
    r2: new Map<string, R2Rec>(),
    fvk: new Map<string, string>(),
    split: new Set<string>(),
    last: 0,
  };
  const said = new Map<string, string>();
  for (const { from, at, body } of readMsgs(msgs)) {
    if (body.id !== R || !members.includes(from)) {
      continue;
    }
    if (body.t !== 'r1' && body.t !== 'r2' && body.t !== 'fvk') {
      continue;
    }
    const key = `${from}:${body.t}`;
    const now = JSON.stringify(body);
    const before = said.get(key);
    if (before !== undefined) {
      if (before !== now) {
        out.split.add(from);
      }
      continue;
    }
    said.set(key, now);
    out.last = Math.max(out.last, at);
    if (body.t === 'r1') {
      out.r1.set(from, { b: body.b, x: body.x, c: body.c, id: r1Id({ R, member: from, ...body }) });
    } else if (body.t === 'r2') {
      const r: R2Rec = { p: body.p, s: body.s, h1: body.h1, id: '' };
      try {
        r.id = r2Id({ R, member: from, ...r });
      } catch {
        out.split.add(from);
        continue;
      }
      out.r2.set(from, r);
    } else {
      out.fvk.set(from, body.h);
    }
  }
  return out;
};

/** how far a member got: 0 nothing yet, 1 round one, 2 round two, 3 their keys checked */
export const stepOf = (c: Keygen, member: string): number =>
  c.fvk.has(member) ? 3 : c.r2.has(member) ? 2 : c.r1.has(member) ? 1 : 0;

/** the setup's step (1 to 3): the furthest every member has reached, plus one */
export const roundOf = (c: Keygen): number =>
  Math.min(3, 1 + Math.min(...c.members.map(m => stepOf(c, m))));

/** members still to do the current step: to agree, or to make a share */
export const behind = (c: Keygen): string[] => {
  if (!c.bound) {
    return c.members.filter(m => !c.agreed.has(m));
  }
  const low = Math.min(...c.members.map(m => stepOf(c, m)));
  return c.members.filter(m => stepOf(c, m) === low && low < 3);
};

/** how long a setup may stand still before the ones behind are shown as missing */
export const MISSING_S = 120;

/** the members holding a setup up: behind, and nothing heard for {@link MISSING_S} */
export const missingOf = (c: Keygen, nowS: number): string[] =>
  nowS - Math.max(c.at, c.last) > MISSING_S ? behind(c) : [];

/**
 * "start again without them": a new wallet for the members left, the
 * threshold kept where it still fits (never below two). Undefined when fewer
 * than two would be left, since one person is not a shared wallet.
 */
export const restartOf = (
  c: Pick<Keygen, 'k' | 'members'>,
  gone: string[],
): { members: string[]; k: number } | undefined => {
  const members = c.members.filter(m => !gone.includes(m));
  return members.length >= 2
    ? { members, k: Math.max(2, Math.min(c.k, members.length)) }
    : undefined;
};

/**
 * The setup cannot finish as it stands: someone said two different things in
 * it, members made round two from different round-one records, or every
 * member checked their keys and they do not match. (A bad reveal is seen
 * only by the member it was sealed to; {@link advance} stops there.)
 */
export const mismatched = (c: Keygen): boolean =>
  c.split.size > 0 ||
  new Set([...c.r2.values()].map(r => r.h1)).size > 1 ||
  (c.members.every(m => c.fvk.has(m)) && new Set(c.fvk.values()).size > 1);

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
    delete next.si;
    delete next.bx;
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
  ufvk(pkp: string, sk: string): Promise<string>;
  address(pkp: string, sk: string): Promise<string>;
}

/** what a finished setup leaves on this device */
export interface Seat {
  /** the roster's id: the wallet payments name */
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
  /** one message's records; `key` names it (`r1:<roster>`), so a caller can pace repeats */
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
 * again at any time: what is kept decides what was done, never memory. Runs
 * only on a bound roster: signing it was this member's agreement.
 */
export const advance = async (
  c: Keygen | undefined,
  mine0: FrostMine | undefined,
  me: Me,
  frost: FrostCalls,
  io: FrostIo,
  label: string,
): Promise<FrostStatus> => {
  if (!c?.bound || !c.members.includes(me.pubkey)) {
    return 'idle';
  }
  const R = c.id;
  const at = c.members.indexOf(me.pubkey);
  const others = c.members.filter(m => m !== me.pubkey);
  let mine = mine0 ?? {};
  if (mine.saved) {
    return 'done';
  }
  if (mismatched(c)) {
    return 'mismatch';
  }
  const send = async (body: FrostBody) => io.post(await packFrost(body), `${body.t}:${body.id}`);
  const commit = () => commitOf(R, at, mine.si!);
  const r1 = () =>
    ({ t: 'r1', v: 2, id: R, b: mine.b1!, x: me.xwingPublicKey, c: commit() }) as const;
  // what this device said before and the room does not show: a post that
  // failed, or a record the relay let go. Said again, the same (the caller paces it).
  if (mine.b1 && mine.si && !c.r1.has(me.pubkey)) {
    await send(r1());
  }
  if (mine.p2 && mine.h1 && mine.bx && !c.r2.has(me.pubkey)) {
    await send({ t: 'r2', v: 2, id: R, p: mine.p2, s: mine.bx, h1: mine.h1 });
  }
  if (mine.fh && !c.fvk.has(me.pubkey)) {
    await send({ t: 'fvk', v: 2, id: R, h: mine.fh });
  }

  if (!mine.b1) {
    const r = await frost.part1(c.members.length, c.k);
    const si = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    mine = await io.keep(R, { s1: r.secret, b1: r.broadcast, si });
    await send(r1());
  }
  if (!others.every(m => c.r1.has(m))) {
    return 'waiting';
  }
  // this device's own round one, as the room should show it
  const own: R1Rec = { b: mine.b1!, x: me.xwingPublicKey, c: commit(), id: '' };
  own.id = r1Id({ R, member: me.pubkey, ...own });
  const r1s = c.members.map(m => (m === me.pubkey ? own : c.r1.get(m)!));
  const theirB = others.map(m => c.r1.get(m)!.b);

  if (!mine.s2) {
    const h1 = h1Of(
      R,
      r1s.map(r => r.id),
    );
    const r = await frost.part2(mine.s1!, theirB);
    // s_i is revealed only now, after every commitment is in: sealed to each member, bound to them
    const bx = c.members.map(m =>
      m === me.pubkey
        ? ''
        : bytesToHex(
            sealXWing(hexToBytes(c.r1.get(m)!.x), hexToBytes(mine.si!), revealAad(R, me.pubkey, m)),
          ),
    );
    mine = await io.keep(R, { s2: r.secret, p2: r.peer_packages, h1, bx });
    await send({ t: 'r2', v: 2, id: R, p: mine.p2!, s: mine.bx!, h1: mine.h1! });
  }
  if (!others.every(m => c.r2.has(m))) {
    return 'waiting';
  }
  // every member made its round two from the same round-one records as this device
  if (others.some(m => c.r2.get(m)!.h1 !== mine.h1)) {
    return 'mismatch';
  }
  if (!mine.fh) {
    // each reveal must open the commitment its member made before any was revealed
    const s: string[] = [];
    for (const [i, m] of c.members.entries()) {
      if (m === me.pubkey) {
        s.push(mine.si!);
        continue;
      }
      let si: string;
      try {
        const box = c.r2.get(m)!.s[at];
        si = bytesToHex(openXWing(me.xwingSeed, hexToBytes(box ?? ''), revealAad(R, m, me.pubkey)));
      } catch {
        return 'mismatch';
      }
      if (commitOf(R, i, si) !== c.r1.get(m)!.c) {
        return 'mismatch';
      }
      s.push(si);
    }
    const sk = skOf(R, s);
    const r = await frost.part3(
      mine.s2!,
      theirB,
      others.flatMap(m => c.r2.get(m)!.p),
    );
    const u = await frost.ufvk(r.public_key_package, sk);
    const a = await frost.address(r.public_key_package, sk);
    const ownR2 = r2Id({ R, member: me.pubkey, p: mine.p2!, s: mine.bx!, h1: mine.h1! });
    const fh = fvkHash({
      R,
      r1: r1s.map(x => x.id),
      r2: c.members.map(m => (m === me.pubkey ? ownR2 : c.r2.get(m)!.id)),
      pkp: r.public_key_package,
      ufvk: u,
      address: a,
    });
    mine = await io.keep(R, {
      kp: r.key_package,
      pkp: r.public_key_package,
      seed: r.ephemeral_seed,
      u,
      a,
      fh,
    });
    await send({ t: 'fvk', v: 2, id: R, h: mine.fh! });
  }
  if (!others.every(m => c.fvk.has(m))) {
    return 'waiting';
  }
  if (others.some(m => c.fvk.get(m) !== mine.fh)) {
    return 'mismatch';
  }
  await io.save({
    ceremony: R,
    members: c.members,
    label,
    threshold: c.k,
    maxSigners: c.members.length,
    address: mine.a!,
    orchardFvk: mine.u!,
    keyPackage: mine.kp!,
    publicKeyPackage: mine.pkp!,
    ephemeralSeed: mine.seed!,
  });
  await io.keep(R, { saved: true });
  return 'done';
};

/** a fresh genesis for a wallet proposed in a room: its own salt, so each proposal is its own */
export const walletGenesis = (members: string[], t: number, creator: string): Genesis => ({
  purpose: 'wallet',
  t,
  n: sortKeys(members).length,
  salt: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
  creator,
});

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
  /** what this device did in a setup or payment, written once per field (see keepMine) */
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
