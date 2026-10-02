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
import { deriveRoomKeys, shortXid, xidOf } from './identity';

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
