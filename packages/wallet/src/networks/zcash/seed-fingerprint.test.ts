import { describe, it, expect } from 'vitest';
import {
  seedFingerprintFromSeed,
  seedFingerprintFromMnemonic,
  seedFingerprintHex,
} from './seed-fingerprint';

describe('zcash ZIP-32 seed fingerprint', () => {
  // Cross-implementation vector: the SAME value the Rust
  // `zip32::fingerprint::SeedFingerprint::from_seed` produces on the zigner side
  // for the 24-word all-zero-entropy BIP39 mnemonic (verified there). If TS and
  // Rust ever diverge, delegation would embed a fingerprint the cold signer
  // rejects - this test pins them together.
  const M24 =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
  const EXPECTED = 'e62855dc1419972e2d8fd349b740de6a67d8cf6feaafe90cf2f37a2344566ccc';

  it('matches the Rust zip32 SeedFingerprint for the 24-word vector', () => {
    expect(seedFingerprintHex(M24)).toBe(EXPECTED);
  });

  it('is 32 bytes and deterministic', () => {
    const a = seedFingerprintFromMnemonic(M24);
    expect(a.length).toBe(32);
    expect(seedFingerprintFromMnemonic(M24)).toEqual(a);
  });

  it('matches the ZIP-32 spec test vector (raw 32-byte seed 0x00..0x1f)', () => {
    // From zip32/src/fingerprint.rs test_seed_fingerprint.
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i);
    const fp = Array.from(seedFingerprintFromSeed(seed), b => b.toString(16).padStart(2, '0')).join(
      '',
    );
    expect(fp).toBe('deff604c246710f7176dead02aa746f2fd8d5389f7072556dcb555fdbe5e3ae3');
  });

  it('rejects an out-of-range seed length', () => {
    expect(() => seedFingerprintFromSeed(new Uint8Array(16))).toThrow(/32\.\.=252/);
  });
});
