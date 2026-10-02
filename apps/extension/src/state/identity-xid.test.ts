/**
 * XID derivations (groups design 4.1, xid plan). The vectors were computed by
 * an independent Python implementation of the zid v2 tree (hashlib, hmac and
 * `cryptography`'s HKDF and Ed25519), whose cross-site key also reproduces the
 * zigner vector pinned in identity.test.ts - so these do not only check the
 * TypeScript against itself.
 *
 * @vitest-environment node
 */

import { describe, expect, test } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils';
import { ed25519 } from '@noble/curves/ed25519';
import { deriveRelationshipKeys, deriveRoomKeys, pairSecret, shortXid, xidOf } from './identity';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const G = '00112233445566778899aabbccddeeff';

describe('xid encoding', () => {
  test('the plan vector: key 00..1f', () => {
    const key = bytesToHex(Uint8Array.from({ length: 32 }, (_, i) => i));
    const xid = xidOf(key);
    expect(xid).toBe('b2b14788c0e1cc8416ca11403b68c6581e31c963962d17ccb1544bc4d18df639');
    expect(shortXid(xid)).toBe('b2b14788');
  });
});

describe('xid-room-v1', () => {
  test('fixed seed and genesis id', () => {
    const k = deriveRoomKeys(PHRASE, 0, G);
    expect(k.pubkey).toBe('e9c5c4f475874a54693cf0c69d62f8a2effce6d765af61657d887552c8687396');
    expect(k.xid).toBe('f5caba932ef1098b99efe8b661219e086c57946732171e8890e04b91258d1242');
    expect(bytesToHex(k.xwingSeed)).toBe(
      'd69939cabe8e346afc175cf5c95b5f1639c6508ed78becb84596fdc6fd68ecc6',
    );
    expect(k.xwingPublicKey).toHaveLength(1216 * 2);
  });

  test('the seed signs for the pubkey', () => {
    const k = deriveRoomKeys(PHRASE, 0, G);
    const msg = new TextEncoder().encode('hello room');
    expect(ed25519.verify(ed25519.sign(msg, k.seed), msg, k.pubkey)).toBe(true);
  });

  test('another genesis id gives an unrelated key', () => {
    const a = deriveRoomKeys(PHRASE, 0, G);
    const b = deriveRoomKeys(PHRASE, 0, 'ffeeddccbbaa99887766554433221100');
    expect(b.pubkey).toBe('e726287aaa0db05b6a3c85cf1fc43f9c315d9cd3f46545e9ac979eb88ace5a86');
    expect(b.pubkey).not.toBe(a.pubkey);
    expect(b.xwingPublicKey).not.toBe(a.xwingPublicKey);
  });

  test('pinned to its generation: gen 1 is a different key, gen 0 never moves', () => {
    const g1 = deriveRoomKeys(PHRASE, 1, G);
    expect(g1.pubkey).toBe('6cb980f1b397b608d23beb0c93b053421c68900b190a37e91d4bfd2c7eb38b1b');
    // deriving gen 1 does not disturb gen 0: the room key depends only on (gen, G)
    expect(deriveRoomKeys(PHRASE, 0, G).pubkey).toBe(
      'e9c5c4f475874a54693cf0c69d62f8a2effce6d765af61657d887552c8687396',
    );
  });

  test('refuses a genesis id that is not 16 bytes of lowercase hex', () => {
    expect(() => deriveRoomKeys(PHRASE, 0, 'G')).toThrow();
    expect(() => deriveRoomKeys(PHRASE, 0, G.toUpperCase())).toThrow();
  });
});

const BOB = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

describe('xid-rel-v1', () => {
  test('fixed seed vectors per (gen, j)', () => {
    const r0 = deriveRelationshipKeys(PHRASE, 0, 0);
    expect(r0.pubkey).toBe('9531c771430fffaa0c8c072993251991bff87aebc5bf672dc94ee55333db3f7a');
    expect(r0.xid).toBe('3d01d6e8eeb7c0802a855d7e0c4d2c5bb31b742b839ad67b0f44926aa784fdc5');
    expect(r0.kaPublicKey).toBe('07abf5f0dfc24d0a253009ac11b8b4cfb7a5e1976d42bc3f1f41606903beed2a');
    expect(bytesToHex(r0.xwingSeed)).toBe(
      'caa3af074c1ebfc8e934deab070147834f9f458104407eff3bb2077851bc6f29',
    );
    const r1 = deriveRelationshipKeys(PHRASE, 0, 1);
    expect(r1.pubkey).toBe('f3cd202f1a65f1215cc28591384bbe3b5ea0a778d4d92de0edb3f8d3a18bf149');
    expect(r1.kaPublicKey).toBe('2af47d6e496fbf262c4f7f4e5b24342f176f69725a9ff10af6deb354e2988357');
  });

  test('two people hold unlinkable keys, and none is a room key', () => {
    const [a, b] = [deriveRelationshipKeys(PHRASE, 0, 0), deriveRelationshipKeys(PHRASE, 0, 1)];
    expect(new Set([a.pubkey, b.pubkey, a.kaPublicKey, b.kaPublicKey]).size).toBe(4);
    expect(a.pubkey).not.toBe(deriveRoomKeys(PHRASE, 0, G).pubkey);
  });

  test('pinned: rotating the generation leaves an existing j alone', () => {
    expect(deriveRelationshipKeys(PHRASE, 1, 0).pubkey).toBe(
      '62db4c200fcaedd61ed284abca10278b823c66e4bf0498188693cedca3b34e2f',
    );
    expect(deriveRelationshipKeys(PHRASE, 0, 0).pubkey).toBe(
      '9531c771430fffaa0c8c072993251991bff87aebc5bf672dc94ee55333db3f7a',
    );
  });

  test('both sides of a pair compute one secret (vector)', () => {
    const a = deriveRelationshipKeys(PHRASE, 0, 0);
    const b = deriveRelationshipKeys(BOB, 0, 3);
    expect(b.kaPublicKey).toBe('f28e69df79e7100527168f5dd25eb21ac69af092c12f483877ef23d0c1f9e640');
    const ab = bytesToHex(pairSecret(a.kaSeed, b.kaPublicKey, a.xid, b.xid));
    const ba = bytesToHex(pairSecret(b.kaSeed, a.kaPublicKey, b.xid, a.xid));
    expect(ab).toBe('3192700b2d6ddaaf0aed29a1f3077190036b1d5a2a75270d56d7d9a8c1dc28a0');
    expect(ba).toBe(ab);
  });

  test('j is a u32', () => {
    expect(() => deriveRelationshipKeys(PHRASE, 0, -1)).toThrow();
    expect(() => deriveRelationshipKeys(PHRASE, 0, 2 ** 32)).toThrow();
  });
});
