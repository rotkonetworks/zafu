/**
 * The records a group speaks in, and its door (groups design 3.2).
 *
 * A group is a sealed zirc room (`zafu-group-v1`, 4 KiB entries) whose roster
 * is a zirc channel log the founder writes: genesis, `+v` per member. The
 * room secret never goes into a code or a link. The code (`673-chaos-mail-kite`)
 * opens a DOOR: a second sealed room, `zafu-door-v1`, keyed by
 * scrypt(code, "zafu-group-door-v2"), where
 *
 *   founder  -> `card`   the group's name, its genesis id G and the founder's key
 *   joiner   -> `ask`    their room key for G, their name, their X-Wing key
 *   founder  -> `invite` the room secret, X-Wing sealed to that one joiner
 *
 * and nothing else. The relay keeps a door an hour.
 *
 * The code: three digits and three words, about 43 bits. The last word is
 * not random: it is 11 bits of SHA-256 over the first three parts and the
 * founder's key, so the code names who made the door.
 *
 * What the door protects, plainly:
 *
 *   - Whoever holds the code reads the card and the asks (names and public
 *     keys). They cannot open an invite: it is sealed to the joiner's own
 *     X-Wing key, derived per room. A holder can post a fake ask; the
 *     founder's "allow" is the defence, and it shows the seal and short XID of
 *     who is asking.
 *   - The relay sees the door's shard on every read and write, so it could try
 *     every code offline. The code is stretched with scrypt (N 2^16, r 8, p 1:
 *     64 MiB, a quarter to half a second in a popup), so that is about 2^43
 *     memory-hard evaluations per door within its hour: not a table lookup.
 *   - A joiner takes the card whose founder the code's last word names, signed
 *     by that founder's key (every zirc record is signed by its author). A
 *     self-chosen timestamp decides nothing. If two different founders both
 *     match - someone who holds the code ground a key to fit the 11 bits - the
 *     joiner refuses the door instead of guessing. The real founder's card is
 *     there from the moment the code exists, so a code holder can deny the
 *     door, not take it over.
 *
 * Doors from before the scrypt code (two words) open nothing here; a door
 * lives an hour, so the founder makes a new one.
 *
 * Every body is `zg1:<kind>:<base64url(lp(field) || lp(field) ...)>`, the
 * length-prefixed shape zid signs with, so a second implementation can parse
 * it without guessing.
 */

import { scryptAsync } from '@noble/hashes/scrypt';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { openXWing, sealXWing } from '@zafu/pq';
import { wordlists } from 'bip39';
import type { ChannelGenesis, ChannelRecord } from '@zafu/zirc';
import { normalizeCode } from './protocol';

export const DOOR_SCOPE = 'zafu-door-v1';
/** a door works for an hour (and the relay's default retention is an hour) */
export const DOOR_MS = 60 * 60_000;

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

/** the first three parts of a code, `673-chaos-mail` */
const codeBase = (code: string): string => normalizeCode(code).split('-').slice(0, 3).join('-');

/**
 * The code's last word: 11 bits of
 * SHA-256(lp("zafu-door-founder-v1") || lp(base) || founderKey).
 */
export const founderWord = (base: string, founder: string): string => {
  const h = sha256(lpAll(['zafu-door-founder-v1', base, hexToBytes(founder)]));
  return WORDS()[((h[0]! << 3) | (h[1]! >> 5)) & 0x7ff]!;
};

/** a fresh code for a door this founder opens: three digits, two words, the founder's word */
export const makeCode = (founder: string): string => {
  const words = WORDS();
  const word = () => words[pick(words.length)]!;
  const base = `${String(pick(1000)).padStart(3, '0')}-${word()}-${word()}`;
  return `${base}-${founderWord(base, founder)}`;
};

/** the code was made by this founder: its last word names their key */
export const codeNames = (code: string, founder: string): boolean =>
  normalizeCode(code).split('-')[3] === founderWord(codeBase(code), founder);

/**
 * scrypt cost for the door secret: N 2^16, r 8, p 1, so 64 MiB and roughly a
 * quarter to half a second in a popup, paid once per code by the founder and
 * once by each joiner. The relay, which sees each door's shard, pays it for
 * every code it tries; at ~2^43 codes that keeps a door's code out of reach for
 * its hour, and the memory keeps GPUs from making it cheap.
 */
export const DOOR_KDF = { N: 2 ** 16, r: 8, p: 1, dkLen: 32 } as const;

/** the door's room secret: scrypt(code, salt "zafu-group-door-v2") */
export const doorSecret = (code: string): Promise<Uint8Array> =>
  scryptAsync(enc.encode(normalizeCode(code)), enc.encode('zafu-group-door-v2'), DOOR_KDF);

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

export type GroupWire =
  | { kind: 'card'; G: string; founder: string; group: string; from: string; count: number }
  | { kind: 'ask'; key: string; name: string; seal: string }
  | { kind: 'invite'; to: string; sealed: Uint8Array }
  | { kind: 'log'; entry: ChannelGenesis | ChannelRecord }
  | { kind: 'names'; names: Record<string, string> };

const HEX64 = /^[0-9a-f]{64}$/;
const G_RE = /^[0-9a-f]{32}$/;

export const encodeWire = (r: GroupWire): string => {
  const fields: (string | Uint8Array)[] =
    r.kind === 'card'
      ? [r.G, r.founder, r.group, r.from, String(r.count)]
      : r.kind === 'ask'
        ? [r.key, r.name, hexToBytes(r.seal)]
        : r.kind === 'invite'
          ? [r.to, r.sealed]
          : r.kind === 'log'
            ? [JSON.stringify(r.entry)]
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
    switch (m[1]) {
      case 'card':
        return G_RE.test(t(0)) && HEX64.test(t(1))
          ? {
              kind: 'card',
              G: t(0),
              founder: t(1),
              group: t(2).slice(0, 48),
              from: t(3).slice(0, 32),
              count: Math.min(999, Number.parseInt(t(4), 10) || 1),
            }
          : undefined;
      case 'ask':
        return HEX64.test(t(0)) && f[2]?.length === 1216
          ? { kind: 'ask', key: t(0), name: t(1).slice(0, 32), seal: bytesToHex(f[2]) }
          : undefined;
      case 'invite':
        return HEX64.test(t(0)) && f[1] ? { kind: 'invite', to: t(0), sealed: f[1] } : undefined;
      case 'log':
        return { kind: 'log', entry: JSON.parse(t(0)) as ChannelGenesis | ChannelRecord };
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

// -- the invite ----------------------------------------------------------------

/** what an invite carries: the long-lived room, never the code */
export interface InviteBody {
  secret: string;
  relay: string;
  group: string;
}

export const sealInviteBody = (sealKeyHex: string, body: InviteBody): Uint8Array =>
  sealXWing(hexToBytes(sealKeyHex), enc.encode(JSON.stringify({ v: 1, ...body })));

/** throws unless it opens with this seed and reads as an invite */
export const openInviteBody = (xwingSeed: Uint8Array, sealed: Uint8Array): InviteBody => {
  const v = JSON.parse(dec.decode(openXWing(xwingSeed, sealed))) as Partial<InviteBody> & {
    v?: number;
  };
  if (v.v !== 1 || !/^[0-9a-f]{64}$/.test(v.secret ?? '') || typeof v.relay !== 'string') {
    throw new Error('not an invite');
  }
  return { secret: v.secret!, relay: v.relay, group: String(v.group ?? '').slice(0, 48) };
};
