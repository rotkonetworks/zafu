/**
 * The records a group speaks in, and its door: a code, the magic wormhole way.
 *
 * A group is a sealed zirc room (`zafu-group-v1`, 4 KiB entries) whose roster
 * is a zirc channel log the founder writes: genesis, `+v` per member. The
 * room secret never goes into a code or a link. The code (`7-fern-dusk`) is a
 * number and two words:
 *
 *   - the NUMBER is a nameplate. It is all the relay learns: it picks the
 *     door's mailbox, `zafu-door-v1` at shard HKDF(H(domain, N), window), a
 *     public box anyone with the number can read, kept an hour;
 *   - the WORDS never leave the device. Whoever made the code and whoever
 *     types it run SPAKE2 over them (RustCrypto spake2 in zafu-wasm, see
 *     people/door-run), so the relay, which sees every message, cannot test a
 *     guess offline. A guesser must take part, one guess per run, and the
 *     founder answers at most {@link ANSWERS_PER_CODE} runs per code.
 *
 * In the mailbox:
 *
 *   founder -> `wh` hello   a version and a random salt: two codes that share a
 *                           number (another zafu, the same hour) tell apart by
 *                           it, and a joiner tries each; the wrong one fails
 *   joiner  -> `wj` join    its SPAKE2 message for (salt, its own jid)
 *   founder -> `wa` answer  its own message for that run and a tag over it, so
 *                           a wrong word is seen at once
 *   joiner  -> `wk` confirm its own tag: the words held on both sides
 *   founder -> `wb` box     the invite sealed under that run's key (the room
 *                           secret, the relay, the group, a shared wallet's k
 *                           of n), to the first run whose confirmation held
 *
 * A code lets exactly one person in, the magic wormhole way: once a box has
 * gone out the code is spent, and anyone else who typed it reads that in the
 * mailbox and is told so. A wrong word, or a joiner trying a code that only
 * shares the number, spends nothing: the box waits for words that held.
 *
 * Knowing the words is what lets a person in; there is no second "allow".
 * Both sides are shown two verify words from the run's key, passively, for
 * anyone who wants to compare them out of band.
 *
 * Every body is `zg1:<kind>:<base64url(lp(field) || lp(field) ...)>`, the
 * length-prefixed shape zid signs with, so a second implementation can parse
 * it without guessing.
 */

import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { wordlists } from 'bip39';
import type { ChannelGenesis, ChannelRecord } from '@zafu/zirc';
import type { Deal } from './frost-room';
import { CODE_RE, normalizeCode } from './protocol';

export const DOOR_SCOPE = 'zafu-door-v1';
/** a door works for an hour (and the relay keeps a door an hour) */
export const DOOR_MS = 60 * 60_000;
/** the door protocol this zafu speaks; a hello with another is not answered */
export const DOOR_VERSION = 2;
/** runs a founder answers per code: the one who comes in, and a few wrong words */
export const ANSWERS_PER_CODE = 12;
/** hellos a joiner tries on one number: codes that collided within the hour */
export const SALTS_TRIED = 4;

export { CODE_RE, normalizeCode } from './protocol';

const enc = new TextEncoder();
const dec = new TextDecoder();

const pick = (n: number): number => {
  // rejection sampling: no modulo bias
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  for (;;) {
    const [x] = crypto.getRandomValues(new Uint32Array(1));
    if (x! < limit) {
      return x! % n;
    }
  }
};

const WORDS = (): string[] => wordlists['english'] ?? [];

/** a fresh code: a number from 1 to 999 and two words */
export const makeCode = (): string => {
  const words = WORDS();
  return `${pick(999) + 1}-${words[pick(words.length)]}-${words[pick(words.length)]}`;
};

/** the nameplate and the words of a code that reads as one */
export const splitCode = (raw: string): { plate: number; words: string } | undefined => {
  const code = normalizeCode(raw);
  if (!CODE_RE.test(code)) {
    return undefined;
  }
  const [n, ...words] = code.split('-');
  return { plate: Number(n), words: words.join('-') };
};

/** the door's mailbox: a public secret, a function of the number alone */
export const plateSecret = (plate: number): string =>
  bytesToHex(sha256(lpAll(['zafu-door-plate-v1', String(plate)])));

/** one run's session, hex: the founder's salt and the joiner's id */
export const sessionOf = (salt: string, jid: string): string => salt + jid;

/** the founder's seed for one run, from its door's seed: a run is rebuilt, never kept */
export const runSeed = (doorSeed: string, jid: string): string =>
  bytesToHex(sha256(lpAll(['zafu-door-run-v1', hexToBytes(doorSeed), jid])));

// -- the invite, sealed under a run's key ---------------------------------------

/** what an answer carries: the long-lived room, never the code */
export interface InviteBody {
  secret: string;
  relay: string;
  group: string;
  G: string;
  founder: string;
  /** what the founder calls themselves there */
  from: string;
  /** a shared wallet: its seals and seats, fixed when the code was made */
  want?: { k: number; n: number };
  deal?: Deal;
  /** the window the group was made in: a newcomer reads from there, not the relay's 48 h */
  born?: number;
}

const boxKey = (key: Uint8Array) =>
  crypto.subtle.importKey(
    'raw',
    new Uint8Array(hkdf(sha256, key, undefined, 'zafu-door-box-v1', 32)),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );

export const sealBox = async (key: Uint8Array, body: InviteBody): Promise<Uint8Array> => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await boxKey(key),
    enc.encode(JSON.stringify({ v: DOOR_VERSION, ...body })),
  );
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), 12);
  return out;
};

const HEX64 = /^[0-9a-f]{64}$/;
const G_RE = /^[0-9a-f]{32}$/;

/** throws unless it opens with this key and reads as an invite */
export const openBox = async (key: Uint8Array, box: Uint8Array): Promise<InviteBody> => {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(box.slice(0, 12)) },
    await boxKey(key),
    new Uint8Array(box.slice(12)),
  );
  const v = JSON.parse(dec.decode(pt)) as Partial<InviteBody> & { v?: number };
  const want = v.want;
  if (
    v.v !== DOOR_VERSION ||
    !HEX64.test(v.secret ?? '') ||
    !G_RE.test(v.G ?? '') ||
    !HEX64.test(v.founder ?? '') ||
    typeof v.relay !== 'string' ||
    (want !== undefined &&
      !(
        Number.isInteger(want.k) &&
        Number.isInteger(want.n) &&
        want.k >= 2 &&
        want.k <= want.n &&
        want.n <= 32
      ))
  ) {
    throw new Error('not an invite');
  }
  return {
    secret: v.secret!,
    relay: v.relay,
    group: String(v.group ?? '').slice(0, 48),
    G: v.G!,
    founder: v.founder!,
    from: String(v.from ?? '').slice(0, 32),
    ...(want ? { want: { k: want.k, n: want.n } } : {}),
    ...(v.deal ? { deal: v.deal } : {}),
    ...(Number.isInteger(v.born) && v.born! >= 0 ? { born: v.born } : {}),
  };
};

// -- the record codec --------------------------------------------------------

const b64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const fromB64url = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

const lpAll = (fields: (string | Uint8Array)[]): Uint8Array => {
  const parts = fields.map(f => (typeof f === 'string' ? enc.encode(f) : f));
  const out = new Uint8Array(parts.reduce((n, p) => n + 4 + p.length, 0));
  let at = 0;
  for (const p of parts) {
    new DataView(out.buffer).setUint32(at, p.length);
    out.set(p, at + 4);
    at += 4 + p.length;
  }
  return out;
};

const unLp = (b: Uint8Array): Uint8Array[] => {
  const out: Uint8Array[] = [];
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let at = 0; at < b.length; ) {
    if (at + 4 > b.length) {
      throw new Error('truncated');
    }
    const n = view.getUint32(at);
    if (at + 4 + n > b.length) {
      throw new Error('truncated');
    }
    out.push(b.slice(at + 4, at + 4 + n));
    at += 4 + n;
  }
  return out;
};

/** what the door's mailbox says; hex and base64 strings, so a room keeps them as they are */
export type DoorWire =
  | { kind: 'wh'; v: number; salt: string }
  | { kind: 'wj'; v: number; salt: string; jid: string; y: string }
  | { kind: 'wa'; v: number; salt: string; jid: string; x: string; tag: string }
  | { kind: 'wk'; v: number; salt: string; jid: string; tag: string }
  | { kind: 'wb'; v: number; salt: string; jid: string; box: string };

export type GroupWire =
  | DoorWire
  /** `t`: the door run that let them in, so the founder can say who came with which code */
  | { kind: 'ask'; key: string; name: string; seal: string; t?: string }
  | { kind: 'log'; entry: ChannelGenesis | ChannelRecord }
  | { kind: 'names'; names: Record<string, string> }
  /** one piece of a FROST message (people/frost-room): `i` of `n`, all sharing `mid` */
  | { kind: 'kc'; mid: string; i: number; n: number; data: Uint8Array }
  /** in a pair room: "join my deal group", its code and name (people/deal) */
  | { kind: 'dj'; code: string; group: string };

const SALT = /^[0-9a-f]{32}$/;
const JID = /^[0-9a-f]{16}$/;
/** a SPAKE2 message (33 bytes) and a tag (32), hex */
const MSG = /^[0-9a-f]{66}$/;
const TAG = HEX64;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

export const encodeWire = (r: GroupWire): string => {
  const fields: (string | Uint8Array)[] =
    r.kind === 'wh'
      ? [String(r.v), r.salt]
      : r.kind === 'wj'
        ? [String(r.v), r.salt, r.jid, r.y]
        : r.kind === 'wa'
          ? [String(r.v), r.salt, r.jid, r.x, r.tag]
          : r.kind === 'wk'
            ? [String(r.v), r.salt, r.jid, r.tag]
            : r.kind === 'wb'
              ? [String(r.v), r.salt, r.jid, r.box]
              : r.kind === 'ask'
                ? [r.key, r.name, hexToBytes(r.seal), ...(r.t ? [r.t] : [])]
                : r.kind === 'log'
                  ? [JSON.stringify(r.entry)]
                  : r.kind === 'kc'
                    ? [r.mid, String(r.i), String(r.n), r.data]
                    : r.kind === 'dj'
                      ? [r.code, r.group]
                      : [JSON.stringify(r.names)];
  return `zg1:${r.kind}:${b64url(lpAll(fields))}`;
};

/** a record body as a group record, or undefined when it is not one we read */
export const decodeWire = (body: string): GroupWire | undefined => {
  const m = /^zg1:([a-z]+):([A-Za-z0-9_-]*)$/.exec(body);
  if (!m) {
    return undefined;
  }
  try {
    const f = unLp(fromB64url(m[2]!));
    const t = (i: number) => dec.decode(f[i] ?? new Uint8Array());
    const v = Number.parseInt(t(0), 10);
    switch (m[1]) {
      // a door record of another version still reads, so a joiner can say which side is older
      case 'wh':
        return Number.isInteger(v) && SALT.test(t(1)) ? { kind: 'wh', v, salt: t(1) } : undefined;
      case 'wj':
        return Number.isInteger(v) && SALT.test(t(1)) && JID.test(t(2)) && MSG.test(t(3))
          ? { kind: 'wj', v, salt: t(1), jid: t(2), y: t(3) }
          : undefined;
      case 'wa':
        return Number.isInteger(v) &&
          SALT.test(t(1)) &&
          JID.test(t(2)) &&
          MSG.test(t(3)) &&
          TAG.test(t(4))
          ? { kind: 'wa', v, salt: t(1), jid: t(2), x: t(3), tag: t(4) }
          : undefined;
      case 'wk':
        return Number.isInteger(v) && SALT.test(t(1)) && JID.test(t(2)) && TAG.test(t(3))
          ? { kind: 'wk', v, salt: t(1), jid: t(2), tag: t(3) }
          : undefined;
      case 'wb':
        return Number.isInteger(v) &&
          SALT.test(t(1)) &&
          JID.test(t(2)) &&
          B64.test(t(3)) &&
          t(3).length <= 3000
          ? { kind: 'wb', v, salt: t(1), jid: t(2), box: t(3) }
          : undefined;
      case 'ask':
        return HEX64.test(t(0)) && f[2]?.length === 1216
          ? {
              kind: 'ask',
              key: t(0),
              name: t(1).slice(0, 32),
              seal: bytesToHex(f[2]),
              ...(JID.test(t(3)) ? { t: t(3) } : {}),
            }
          : undefined;
      case 'log':
        return { kind: 'log', entry: JSON.parse(t(0)) as ChannelGenesis | ChannelRecord };
      case 'kc': {
        const [i, n] = [Number(t(1)), Number(t(2))];
        return /^[0-9a-f]{16}$/.test(t(0)) &&
          Number.isInteger(i) &&
          Number.isInteger(n) &&
          n <= 64 &&
          i >= 0 &&
          i < n &&
          f[3]
          ? { kind: 'kc', mid: t(0), i, n, data: f[3] }
          : undefined;
      }
      case 'dj':
        return CODE_RE.test(t(0))
          ? { kind: 'dj', code: t(0), group: t(1).slice(0, 48) }
          : undefined;
      case 'names': {
        const names = JSON.parse(t(0)) as unknown;
        return names && typeof names === 'object'
          ? { kind: 'names', names: names as Record<string, string> }
          : undefined;
      }
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
};

export const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
export const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), c => c.charCodeAt(0));
