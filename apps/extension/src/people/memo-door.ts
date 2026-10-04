/**
 * The memo door: a chat invite that rides a shielded memo, beside the code
 * and the links on the ZafuLinks board. The memo is already end-to-end
 * encrypted to its recipient, so the invite can carry what the code door has
 * to bootstrap through a relay: the room's secret itself, and the relay the
 * sender chose. No relay round trip, nothing to guess.
 *
 *   zafu:m1/<base64url(payload)>
 *
 *   payload, version 1 (every string is u8 length + UTF-8):
 *     0x01 version | kind (0x01 pair, 0x02 group) | fields
 *     pair:  secret[32] inception[32] pairKa[32] name address relay
 *     group: secret[32] G[16] founder[32] group from relay
 *
 * A pair invite carries the sender's card for this one person: their
 * relationship's inception key, its pair key and the address they gave you.
 * Nothing in it is the identity key or anything another person was given.
 * An empty relay means the people-relay default.
 *
 * Size: 512 bytes of zcash memo; 432 bytes of penumbra memo text (512 less
 * the 80-byte return address, which is the address there, so a penumbra
 * invite leaves its address out).
 */

import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { relayBase } from '../config/people-relay';

export const MEMO_DOOR_PREFIX = 'zafu:m1/';
export const MEMO_DOOR_VERSION = 0x01;
export const ZCASH_MEMO_BYTES = 512;
export const PENUMBRA_MEMO_TEXT_BYTES = 432;

const KIND_PAIR = 0x01;
const KIND_GROUP = 0x02;

export type MemoInvite =
  | {
      kind: 'pair';
      secret: string;
      inception: string;
      pairKa: string;
      name: string;
      /** the address the sender gave you; empty on penumbra (the return address is it) */
      address: string;
      /** relay base url, '' for the default */
      relay: string;
    }
  | {
      kind: 'group';
      secret: string;
      G: string;
      founder: string;
      group: string;
      from: string;
      relay: string;
    };

export type MemoDoorRead =
  | { ok: true; invite: MemoInvite }
  /** a zafu invite this zafu cannot read: a newer version, or damaged */
  | { ok: false; reason: 'version' | 'unreadable' };

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const fromB64url = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

const str = (s: string, max: number, what: string): number[] => {
  const b = enc.encode(s);
  if (b.length > max) {
    throw new Error(`the ${what} is too long for a memo invite`);
  }
  return [b.length, ...b];
};

const key = (hex: string, n: number, what: string): number[] => {
  if (!new RegExp(`^[0-9a-f]{${n * 2}}$`).test(hex)) {
    throw new Error(`a memo invite needs a ${what}`);
  }
  return [...hexToBytes(hex)];
};

/** the invite as one memo line; throws when it would not fit `limit` bytes */
export const encodeMemoInvite = (i: MemoInvite, limit = ZCASH_MEMO_BYTES): string => {
  const relay = i.relay ? (relayBase(i.relay) ?? '') : '';
  if (i.relay && !relay) {
    throw new Error('a memo invite names a relay by its https or http url');
  }
  const body =
    i.kind === 'pair'
      ? [
          KIND_PAIR,
          ...key(i.secret, 32, 'room secret'),
          ...key(i.inception, 32, 'card key'),
          ...key(i.pairKa, 32, 'pair key'),
          ...str(i.name, 24, 'name'),
          ...str(i.address, 200, 'address'),
          ...str(relay, 64, 'relay'),
        ]
      : [
          KIND_GROUP,
          ...key(i.secret, 32, 'room secret'),
          ...key(i.G, 16, 'group id'),
          ...key(i.founder, 32, 'founder key'),
          ...str(i.group, 48, 'group name'),
          ...str(i.from, 24, 'name'),
          ...str(relay, 64, 'relay'),
        ];
  const line = MEMO_DOOR_PREFIX + b64url(new Uint8Array([MEMO_DOOR_VERSION, ...body]));
  if (enc.encode(line).length > limit) {
    throw new Error(`this invite needs ${enc.encode(line).length} bytes; a memo holds ${limit}`);
  }
  return line;
};

const LINE = /zafu:m1\/([A-Za-z0-9_-]{8,700})/;

/** does this memo text carry a memo invite at all (any version) */
export const hasMemoInvite = (text: string): boolean => LINE.test(text);

/** the invite in a memo's text; a version this zafu does not know is said calmly, never guessed */
export const readMemoInvite = (text: string): MemoDoorRead | undefined => {
  const m = LINE.exec(text);
  if (!m) {
    return undefined;
  }
  try {
    const b = fromB64url(m[1]!);
    if (b[0] !== MEMO_DOOR_VERSION) {
      return { ok: false, reason: 'version' };
    }
    let at = 2;
    const take = (n: number) => {
      if (at + n > b.length) {
        throw new Error('short');
      }
      const out = b.slice(at, at + n);
      at += n;
      return out;
    };
    const hex = (n: number) => bytesToHex(take(n));
    const text_ = () => dec.decode(take(take(1)[0]!));
    const kind = b[1];
    const invite: MemoInvite | undefined =
      kind === KIND_PAIR
        ? {
            kind: 'pair',
            secret: hex(32),
            inception: hex(32),
            pairKa: hex(32),
            name: text_(),
            address: text_(),
            relay: text_(),
          }
        : kind === KIND_GROUP
          ? {
              kind: 'group',
              secret: hex(32),
              G: hex(16),
              founder: hex(32),
              group: text_(),
              from: text_(),
              relay: text_(),
            }
          : undefined;
    if (!invite || at !== b.length || (invite.relay && relayBase(invite.relay) !== invite.relay)) {
      return { ok: false, reason: 'unreadable' };
    }
    return { ok: true, invite };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
};
