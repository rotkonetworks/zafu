/**
 * ZID derivation cross-repo compatibility.
 *
 * These test vectors are shared with zigner/rust/signer/src/auth.rs.
 * Any change here must be mirrored in zigner, and vice versa.
 *
 * If either repo fails these vectors, zafu and zigner will produce
 * different pubkeys for the same seed - breaking "same device across
 * zafu and zigner = same identity" guarantee.
 *
 * One tag branch exists beyond the legacy form: an origin containing ':'
 * (an explicit port) is tagged 'site\0<origin>\0<rotation>' instead of
 * 'site:<origin>[:<rotation>]', because the legacy form lets 'a.com:7' at
 * rotation 0 collide with 'a.com' at rotation 7. Portless origins are
 * byte-identical to the legacy tag, so no issued key changes.
 *
 * @vitest-environment node
 */

import { describe, expect, test } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils';
import {
  deriveZidCrossSite,
  deriveZidForSite,
  deriveRelationshipKeys,
  discoverySecret,
  pairSecret,
  DEFAULT_IDENTITY,
} from './identity';

const TEST_PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('ZID v2 cross-repo compat', () => {
  test('cross-site default matches zigner test vector', () => {
    const zid = deriveZidCrossSite(TEST_PHRASE, DEFAULT_IDENTITY);
    // Pinned in zigner: auth.rs::test_zid_pubkey_matches_zafu
    expect(zid.publicKey).toBe('c19e35c5735667f974a39729fddb3b19fb90f325fd9fdbed7b3bf32116e97835');
  });

  test('site-specific example.com rotation 0 matches zigner', () => {
    const zid = deriveZidForSite(TEST_PHRASE, DEFAULT_IDENTITY, 'https://example.com', 0);
    // Pinned in zigner: auth.rs::test_sign_zid_site_specific_matches_zafu
    // A portless origin keeps the legacy tag byte-for-byte, so this vector is
    // unchanged and existing site keys stay valid.
    expect(zid.publicKey).toBe('3f96957e3a6ded64243bc0a3926faf79c25ddfb93b33c4d15d787fb13322ec5f');
  });

  test('site-specific example.com rotation 1 matches zigner', () => {
    const zid = deriveZidForSite(TEST_PHRASE, DEFAULT_IDENTITY, 'https://example.com', 1);
    // Pinned in zigner: auth.rs::test_sign_zid_site_specific_matches_zafu
    expect(zid.publicKey).toBe('9eb0ab0f2c8c252e04b7dd4af0615ffe209171162523347e1a402bbdcffb42a5');
  });

  test('origin with a port cannot collide with the rotation field', () => {
    // Before the port branch the tag was 'site:'+origin at rotation 0 and
    // 'site:'+origin+':'+rotation otherwise, so these two were EQUAL bytes.
    const portAtZero = deriveZidForSite(TEST_PHRASE, DEFAULT_IDENTITY, 'https://x.com:7', 0);
    const rotAtSeven = deriveZidForSite(TEST_PHRASE, DEFAULT_IDENTITY, 'https://x.com', 7);
    expect(portAtZero.publicKey).not.toBe(rotAtSeven.publicKey);
  });

  test('ported origin pins the branch (zigner MUST mirror)', () => {
    // Portless origins keep the legacy tag; an origin containing ':' switches to
    // 'site\0'+origin+'\0'+rotation. zigner/auth.rs must branch identically or a
    // ported origin signs with a different key than zafu derives.
    const zid = deriveZidForSite(TEST_PHRASE, DEFAULT_IDENTITY, 'https://x.com:7', 0);
    expect(zid.publicKey).toBe('f7610fa86e280998f18dc5913cf5644b6d9bf67aa1776a735ad3dbc2239f66a6');
  });

  test('different identities produce different cross-site keys', () => {
    const def = deriveZidCrossSite(TEST_PHRASE, 'default');
    const poker = deriveZidCrossSite(TEST_PHRASE, 'poker');
    expect(def.publicKey).not.toBe(poker.publicKey);
  });

  test('deterministic across invocations', () => {
    const a = deriveZidCrossSite(TEST_PHRASE, DEFAULT_IDENTITY);
    const b = deriveZidCrossSite(TEST_PHRASE, DEFAULT_IDENTITY);
    expect(a.publicKey).toBe(b.publicKey);
  });

  test('address format is zid + 16 hex chars', () => {
    const zid = deriveZidCrossSite(TEST_PHRASE, DEFAULT_IDENTITY);
    expect(zid.address).toBe('zidc19e35c5735667f9');
    expect(zid.address.length).toBe(19); // "zid" + 16
  });
});

describe('discovery secret (per relationship)', () => {
  const PHRASE_B = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';

  test('both sides of one relationship derive the same secret', () => {
    const a = deriveRelationshipKeys(TEST_PHRASE, 0, 3);
    const b = deriveRelationshipKeys(PHRASE_B, 0, 7);
    const sAB = discoverySecret(a.kaSeed, b.kaPublicKey, a.xid, b.xid);
    const sBA = discoverySecret(b.kaSeed, a.kaPublicKey, b.xid, a.xid);
    expect(bytesToHex(sAB)).toBe(bytesToHex(sBA));
    expect(sAB.length).toBe(32);
  });

  test('it is not the pair-room secret of the same two keys', () => {
    const a = deriveRelationshipKeys(TEST_PHRASE, 0, 0);
    const b = deriveRelationshipKeys(PHRASE_B, 0, 0);
    expect(bytesToHex(discoverySecret(a.kaSeed, b.kaPublicKey, a.xid, b.xid))).not.toBe(
      bytesToHex(pairSecret(a.kaSeed, b.kaPublicKey, a.xid, b.xid)),
    );
  });

  test('two people get two unrelated KA keys from you', () => {
    const forBob = deriveRelationshipKeys(TEST_PHRASE, 0, 0);
    const forCarol = deriveRelationshipKeys(TEST_PHRASE, 0, 1);
    expect(forBob.kaPublicKey).not.toBe(forCarol.kaPublicKey);
  });
});
