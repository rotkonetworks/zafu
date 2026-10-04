/**
 * Contact card v2: one signed card per relationship (design-contact-card-v2).
 *
 * The same bytes travel as a QR, a `zafu.pro/c#` link and a shielded memo
 * (MemoType 0x05, version byte 2: a v1 reader returns null on it, so an older
 * zafu ignores v2 cards). Every field is signed by the relationship's
 * inception key, so nothing can be swapped in transit and a later `update`
 * provably comes from the same person.
 *
 *   ver      u8   0x02
 *   kind     u8   0 card, 1 answer, 2 update, 3 close
 *   flags    u8   bit0 answers, bit1 zcash, bit2 penumbra, bit3 testnet
 *   revision u16be
 *   key      32   ed25519 inception key of this relationship (xid-rel-v1)
 *   pairKa   32   X25519 key: the pair room and discovery
 *   answers  16   sha256(their inception key)[0..16], when answering theirs
 *   zcash    43   raw orchard receiver, made for this one person
 *   penumbra 80   raw penumbra address, only while penumbra is on
 *   relay    u8 len + host[:port][/path]; https assumed, `http://` kept; 0 = relay.zafu.pro
 *   caps     u16be capability bits ({@link Cap})
 *   name     u8 len + UTF-8, at most 32 bytes; 0 = no name (the default)
 *   created  u32be unix minutes
 *   ext      u8 count, then each: tag u8, len u16be, value - fields a later
 *            zafu adds (skipped by this one, but signed)
 *   sig      64   ed25519 over utf8("zafu-card-v2") || every byte above
 *
 * The card delimits itself, so a memo's zero padding after it is ignored
 * (and anything else after it refused). About 185 bytes plain, 265 with
 * penumbra: one memo. A card that ever grows
 * past one memo (an X-Wing key in an extension) is split by the memo codec's
 * fragments; a link and a QR always carry the whole card.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  MemoType,
  PAYLOAD_SINGLE,
  decodeMemo,
  encodeFragmented,
  encodeMemo,
  reassemble,
} from './memo-codec';

export const CARD_V2 = 0x02;
export const CARD_V2_DOMAIN = 'zafu-card-v2';
export const CARD_DEFAULT_RELAY = 'https://relay.zafu.pro';

export const CARD_KINDS = ['card', 'answer', 'update', 'close'] as const;
export type CardKind = (typeof CARD_KINDS)[number];

/** capability bits; calls only once the person turned them on */
export const Cap = {
  chat: 1,
  mailbox: 2,
  calls: 4,
  deals: 8,
  discovery: 16,
} as const;

export interface CardV2 {
  kind: CardKind;
  revision: number;
  /** ed25519 inception key, hex */
  key: string;
  /** X25519 pair key, hex */
  pairKa: string;
  /** sha256(their inception key)[0..16], hex */
  answers?: string;
  /** raw 43-byte orchard receiver, hex */
  zcash?: string;
  /** raw 80-byte penumbra address, hex */
  penumbra?: string;
  testnet?: boolean;
  /** relay base url */
  relay: string;
  caps: number;
  name?: string;
  /** unix minutes */
  created: number;
  ext?: { tag: number; value: Uint8Array }[];
}

const SIG = 64;
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

/** what an answering card says about the card it answers */
export const answersOf = (keyHex: string): string =>
  bytesToHex(sha256(hexToBytes(keyHex))).slice(0, 32);

const relayBytes = (relay: string): Uint8Array => {
  const r = relay.replace(/\/+$/, '');
  if (!r || r === CARD_DEFAULT_RELAY) {
    return new Uint8Array();
  }
  if (!/^https?:\/\/[^\s/]+/.test(r)) {
    throw new Error('a card names its relay by an https or http url');
  }
  const b = enc.encode(r.replace(/^https:\/\//, ''));
  if (b.length > 120) {
    throw new Error('the relay url is too long for a card');
  }
  return b;
};

const fixed = (hex: string | undefined, n: number, what: string): Uint8Array => {
  if (!hex || !new RegExp(`^[0-9a-f]{${n * 2}}$`).test(hex)) {
    throw new Error(`a card needs a ${what}`);
  }
  return hexToBytes(hex);
};

/** the card's bytes before its signature */
const body = (c: CardV2): Uint8Array => {
  if (!CARD_KINDS.includes(c.kind)) {
    throw new Error('unknown card kind');
  }
  const name = enc.encode(c.name ?? '');
  if (name.length > 32) {
    throw new Error('a card name is at most 32 bytes');
  }
  if (!Number.isInteger(c.revision) || c.revision < 0 || c.revision > 0xffff) {
    throw new Error('a card revision is a u16');
  }
  const relay = relayBytes(c.relay);
  const flags =
    (c.answers ? 1 : 0) | (c.zcash ? 2 : 0) | (c.penumbra ? 4 : 0) | (c.testnet ? 8 : 0);
  const out: number[] = [
    CARD_V2,
    CARD_KINDS.indexOf(c.kind),
    flags,
    c.revision >> 8,
    c.revision & 0xff,
    ...fixed(c.key, 32, 'relationship key'),
    ...fixed(c.pairKa, 32, 'pair key'),
    ...(c.answers ? fixed(c.answers, 16, 'answers hash') : []),
    ...(c.zcash ? fixed(c.zcash, 43, 'zcash receiver') : []),
    ...(c.penumbra ? fixed(c.penumbra, 80, 'penumbra address') : []),
    relay.length,
    ...relay,
    (c.caps >> 8) & 0xff,
    c.caps & 0xff,
    name.length,
    ...name,
    (c.created >>> 24) & 0xff,
    (c.created >>> 16) & 0xff,
    (c.created >>> 8) & 0xff,
    c.created & 0xff,
  ];
  out.push((c.ext ?? []).length);
  for (const e of c.ext ?? []) {
    out.push(e.tag & 0xff, e.value.length >> 8, e.value.length & 0xff, ...e.value);
  }
  return new Uint8Array(out);
};

const preimage = (b: Uint8Array) => new Uint8Array([...enc.encode(CARD_V2_DOMAIN), ...b]);

/** the signed card; `seed` is the relationship's ed25519 secret and must be `card.key`'s */
export const signCardV2 = (card: CardV2, seed: Uint8Array): Uint8Array => {
  if (bytesToHex(ed25519.getPublicKey(seed)) !== card.key) {
    throw new Error('a card is signed by its own relationship key');
  }
  const b = body(card);
  return new Uint8Array([...b, ...ed25519.sign(preimage(b), seed)]);
};

const relayOf = (host: string): string => {
  if (!host) {
    return CARD_DEFAULT_RELAY;
  }
  return /^https?:\/\//.test(host) ? host : `https://${host}`;
};

/** a signed v2 card, or null when it does not parse or its signature does not hold */
export const readCardV2 = (bytes: Uint8Array): CardV2 | null => parse(bytes)?.card ?? null;

/** the card's own bytes, without a memo's padding; null unless it reads and verifies */
export const exactCardV2 = (bytes: Uint8Array): Uint8Array | null => {
  const p = parse(bytes);
  return p ? bytes.slice(0, p.end) : null;
};

const parse = (bytes: Uint8Array): { card: CardV2; end: number } | null => {
  try {
    if (bytes[0] !== CARD_V2) {
      return null;
    }
    const b = bytes;
    let at = 0;
    const take = (n: number) => {
      if (at + n > b.length) {
        throw new Error('short');
      }
      at += n;
      return b.subarray(at - n, at);
    };
    const u8 = (): number => take(1)[0] ?? 0;
    const u16 = () => (u8() << 8) | u8();
    take(1);
    const kind = CARD_KINDS[u8()];
    const flags = u8();
    if (!kind || flags & 0xf0) {
      return null;
    }
    const revision = u16();
    const key = bytesToHex(take(32));
    const pairKa = bytesToHex(take(32));
    const answers = flags & 1 ? bytesToHex(take(16)) : undefined;
    const zcash = flags & 2 ? bytesToHex(take(43)) : undefined;
    const penumbra = flags & 4 ? bytesToHex(take(80)) : undefined;
    const host = dec.decode(take(u8()));
    const caps = u16();
    const name = dec.decode(take(u8()));
    const created = ((u16() << 16) >>> 0) + u16();
    const ext = Array.from({ length: u8() }, () => {
      const tag = u8();
      return { tag, value: take(u16()).slice() };
    });
    const signed = b.subarray(0, at);
    const sig = take(SIG);
    if (b.subarray(at).some(x => x !== 0) || !ed25519.verify(sig, preimage(signed), key)) {
      return null;
    }
    const card: CardV2 = {
      kind,
      revision,
      key,
      pairKa,
      ...(answers ? { answers } : {}),
      ...(zcash ? { zcash } : {}),
      ...(penumbra ? { penumbra } : {}),
      ...(flags & 8 ? { testnet: true } : {}),
      relay: relayOf(host),
      caps,
      ...(name ? { name } : {}),
      created,
      ...(ext.length ? { ext } : {}),
    };
    return { card, end: at };
  } catch {
    return null;
  }
};

/** the card as zcash memos: one when it fits (it does, by default), fragments when it ever does not */
export const cardV2Memos = (bytes: Uint8Array): Uint8Array[] =>
  bytes.length <= PAYLOAD_SINGLE
    ? [encodeMemo(MemoType.ContactCard, bytes)]
    : encodeFragmented(MemoType.ContactCard, bytes);

/** a card's bytes back from its memos (one, or every fragment of it); null when incomplete */
export const cardFromMemos = (memos: Uint8Array[]): Uint8Array | null => {
  const ps = memos.flatMap(m => {
    const p = decodeMemo(m);
    return p?.type === MemoType.ContactCard ? [p] : [];
  });
  const [first] = ps;
  if (!first || ps.length !== memos.length) {
    return null;
  }
  if (first.total === 1) {
    return first.payload;
  }
  const id = bytesToHex(first.messageId);
  return reassemble(ps.filter(p => bytesToHex(p.messageId) === id));
};

const b64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** the `#` part of a card link: the card's own bytes, unsplit */
export const cardV2Link = (bytes: Uint8Array): string => b64url(bytes);

export const fromB64url = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

export { b64url as cardB64 };
