/**
 * @vitest-environment node
 */
import { describe, expect, test } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';
import {
  CARD_DEFAULT_RELAY,
  Cap,
  answersOf,
  cardFromMemos,
  cardV2Link,
  cardV2Memos,
  exactCardV2,
  fromB64url,
  readCardV2,
  signCardV2,
  type CardV2,
} from './card-v2';
import { decodeContactCard, decodeMemo, encodeContactCard, MemoType } from './memo-codec';

const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!, b => parseInt(b, 16));
const seed = new Uint8Array(32).fill(7);
const key = bytesToHex(ed25519.getPublicKey(seed));
const theirs = bytesToHex(ed25519.getPublicKey(new Uint8Array(32).fill(9)));

const base: CardV2 = {
  kind: 'card',
  revision: 0,
  key,
  pairKa: 'ab'.repeat(32),
  zcash: '11'.repeat(43),
  relay: CARD_DEFAULT_RELAY,
  caps: Cap.chat | Cap.mailbox | Cap.deals,
  created: 29_000_000,
};
const withPenumbra: CardV2 = { ...base, penumbra: '22'.repeat(80) };
const longRelay: CardV2 = {
  ...withPenumbra,
  kind: 'answer',
  answers: answersOf(theirs),
  relay: 'https://relay.a-rather-long-community-host.example.org',
  name: 'ken',
};

describe('card v2', () => {
  test('round-trips every field', () => {
    for (const c of [base, withPenumbra, longRelay]) {
      expect(readCardV2(signCardV2(c, seed))).toEqual(c);
    }
    const close = readCardV2(
      signCardV2({ ...base, kind: 'close', zcash: undefined, revision: 9 }, seed),
    );
    expect(close).toMatchObject({ kind: 'close', revision: 9 });
    expect(close?.zcash).toBeUndefined();
    const http = { ...base, relay: 'http://127.0.0.1:8787', testnet: true };
    expect(readCardV2(signCardV2(http, seed))).toEqual(http);
  });

  test('plain http only to a relay on this computer', () => {
    for (const relay of ['http://localhost:8787', 'http://127.0.0.1', 'http://[::1]:9/r']) {
      expect(readCardV2(signCardV2({ ...base, relay }, seed))?.relay).toBe(relay);
    }
    for (const relay of ['http://tracker.example', 'http://localhost.evil.example', 'ftp://x.y']) {
      expect(() => signCardV2({ ...base, relay }, seed)).toThrow();
    }
    // a card that names plain http elsewhere, signed by hand, does not read
    const byHand = (host: string) => {
      const b = signCardV2({ ...base, relay: 'https://x' }, seed);
      const at = 5 + 64 + 43; // ver, kind, flags, revision, key, pairKa, zcash
      expect(b[at]).toBe(1);
      const h = new TextEncoder().encode(host);
      const unsigned = new Uint8Array([
        ...b.subarray(0, at),
        h.length,
        ...h,
        ...b.subarray(at + 2, b.length - 64),
      ]);
      const pre = new Uint8Array([...new TextEncoder().encode('zafu-card-v2'), ...unsigned]);
      return new Uint8Array([...unsigned, ...ed25519.sign(pre, seed)]);
    };
    expect(readCardV2(byHand('http://localhost:1'))?.relay).toBe('http://localhost:1');
    expect(readCardV2(byHand('http://tracker.example'))).toBeNull();
  });

  test('strict signatures: no small-order keys, no malleable S', () => {
    const good = signCardV2(base, seed);
    // S + L is the same signature under ZIP-215 but not under RFC 8032
    const L = 2n ** 252n + 27742317777372353535851937790883648493n;
    const sig = good.subarray(good.length - 64);
    let s = 0n;
    for (let i = 31; i >= 0; i--) {
      s = (s << 8n) | BigInt(sig[32 + i]!);
    }
    const big = s + L;
    const sBytes = Array.from({ length: 32 }, (_, i) => Number((big >> BigInt(8 * i)) & 0xffn));
    const malleable = new Uint8Array([...good.subarray(0, good.length - 32), ...sBytes]);
    expect(readCardV2(malleable)).toBeNull();
    expect(readCardV2(good)).not.toBeNull();
    // the identity point as a key: S = 0 "verifies" for any message under ZIP-215
    const identity = '01' + '00'.repeat(31);
    const forged = new Uint8Array(good);
    forged.set(fromHex(identity), 5);
    forged.set(new Uint8Array(64).fill(0), forged.length - 64);
    forged.set(fromHex(identity), forged.length - 64);
    expect(readCardV2(forged)).toBeNull();
  });

  test('refuses a card signed by another key, and any changed byte', () => {
    expect(() => signCardV2({ ...base, key: theirs }, seed)).toThrow();
    const bytes = signCardV2(longRelay, seed);
    for (let i = 0; i < bytes.length; i++) {
      const bad = bytes.slice();
      bad[i]! ^= 0x01;
      expect(readCardV2(bad), `byte ${i}`).toBeNull();
    }
    // the key swapped for another's, with the rest intact
    const swapped = bytes.slice();
    swapped.set(ed25519.getPublicKey(new Uint8Array(32).fill(9)), 5);
    expect(readCardV2(swapped)).toBeNull();
    expect(readCardV2(bytes.subarray(0, bytes.length - 1))).toBeNull();
  });

  test('fits one memo, a link and a qr; sizes', () => {
    const sizes = [base, withPenumbra, longRelay].map(c => signCardV2(c, seed).length);
    console.log(
      'card v2 bytes: minimal %d, with penumbra %d, answer + penumbra + long relay + name %d',
      ...sizes,
    );
    expect(sizes[0]).toBe(185);
    expect(sizes[1]).toBe(265);
    for (const c of [base, withPenumbra, longRelay]) {
      const bytes = signCardV2(c, seed);
      expect(cardV2Memos(bytes)).toHaveLength(1);
      expect(readCardV2(cardFromMemos(cardV2Memos(bytes))!)).toEqual(c);
      expect(cardV2Link(bytes).length).toBeLessThan(512);
      expect(fromB64url(cardV2Link(bytes))).toEqual(bytes);
    }
  });

  test('a card past one memo splits into fragments and reassembles', () => {
    // a future X-Wing key (1216 bytes) in an extension
    const big: CardV2 = { ...base, ext: [{ tag: 0x10, value: new Uint8Array(1216).fill(3) }] };
    const bytes = signCardV2(big, seed);
    const memos = cardV2Memos(bytes);
    expect(memos).toHaveLength(3);
    expect(readCardV2(cardFromMemos([memos[2]!, memos[0]!, memos[1]!])!)).toEqual(big);
    expect(cardFromMemos(memos.slice(0, 2))).toBeNull();
  });

  test("a memo's zero padding is ignored, anything else after the card is refused", () => {
    const bytes = signCardV2(base, seed);
    const padded = new Uint8Array(508);
    padded.set(bytes);
    expect(readCardV2(padded)).toEqual(base);
    expect(exactCardV2(padded)).toEqual(bytes);
    padded[400] = 1;
    expect(readCardV2(padded)).toBeNull();
  });

  test('a v1 reader ignores v2, and v1 cards still read', () => {
    const memo = cardV2Memos(signCardV2(base, seed))[0]!;
    const parsed = decodeMemo(memo)!;
    expect(parsed.type).toBe(MemoType.ContactCard);
    expect(decodeContactCard(parsed.payload)).toBeNull();
    const v1 = encodeContactCard({
      name: 'ken',
      address: 'u1' + 'q'.repeat(140),
      flags: 0,
      zid: key,
      pairKa: 'ab'.repeat(32),
    })[0]!;
    expect(decodeContactCard(decodeMemo(v1)!.payload)).toMatchObject({
      version: 1,
      name: 'ken',
      zid: key,
    });
    expect(readCardV2(decodeMemo(v1)!.payload)).toBeNull();
  });
});
