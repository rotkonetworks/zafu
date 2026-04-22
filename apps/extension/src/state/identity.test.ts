/**
 * ZID derivation cross-repo compatibility.
 *
 * These test vectors are shared with zigner/rust/signer/src/auth.rs.
 * Any change here must be mirrored in zigner, and vice versa.
 *
 * If either repo fails these vectors, zafu and zigner will produce
 * different pubkeys for the same seed — breaking "same device across
 * zafu and zigner = same identity" guarantee.
 *
 * @vitest-environment node
 */

import { describe, expect, test } from 'vitest';
import { deriveZidCrossSite, deriveZidForSite, DEFAULT_IDENTITY } from './identity';

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
    expect(zid.publicKey).toBe('3f96957e3a6ded64243bc0a3926faf79c25ddfb93b33c4d15d787fb13322ec5f');
  });

  test('site-specific example.com rotation 1 matches zigner', () => {
    const zid = deriveZidForSite(TEST_PHRASE, DEFAULT_IDENTITY, 'https://example.com', 1);
    // Pinned in zigner: auth.rs::test_sign_zid_site_specific_matches_zafu
    expect(zid.publicKey).toBe('9eb0ab0f2c8c252e04b7dd4af0615ffe209171162523347e1a402bbdcffb42a5');
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
