/**
 * The records a group speaks in, and its door (groups design 3.2).
 *
 * A group is a sealed zirc room (`zafu-group-v1`, 4 KiB entries) whose roster
 * is a zirc channel log the founder writes: genesis, `+v` per member. The
 * room secret never goes into a code or a link. The code (`673-chaos-mail`)
 * opens a DOOR: a second sealed room, `zafu-door-v1`, keyed by
 * HKDF(code, "zafu-group-door-v1"), where
 *
 *   founder  -> `card`   the group's name, its genesis id G and the founder's key
 *   joiner   -> `ask`    their room key for G, their name, their X-Wing key
 *   founder  -> `invite` the room secret, X-Wing sealed to that one joiner
 *
 * and nothing else. The relay keeps a door an hour.
 *
 * What the door protects, plainly: the code is low entropy, so whoever guesses
 * it reads the card and the asks (names and public keys). They cannot open an
 * invite: it is sealed to the joiner's own X-Wing key, derived per room. A
 * guesser can post a fake ask; the founder's "allow" is the defence, and it
 * shows the seal and short XID of who is asking.
 *
 * Every body is `zg1:<kind>:<base64url(lp(field) || lp(field) ...)>`, the
 * length-prefixed shape zid signs with, so a second implementation can parse
 * it without guessing.
 */

import { hkdf } from '@noble/hashes/hkdf';
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

export const makeCode = (): string => {
  const words = wordlists['english'] ?? [];
  const word = () => words[pick(words.length)]!;
  return `${String(pick(1000)).padStart(3, '0')}-${word()}-${word()}`;
};

/** the door's room secret: HKDF-SHA256(code, info "zafu-group-door-v1") */
export const doorSecret = (code: string): Uint8Array =>
  hkdf(sha256, enc.encode(normalizeCode(code)), undefined, enc.encode('zafu-group-door-v1'), 32);

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
