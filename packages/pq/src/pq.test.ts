import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import {
  XWING_LENGTHS,
  XWING_SUITE,
  xwingKeypairFromSeed,
  xwingPublicKeyFromSeed,
  xwingEncapsulate,
  xwingDecapsulate,
  MLKEM768_LENGTHS,
  mlkem768KeygenEphemeral,
  mlkem768KeypairFromSeed,
  mlkem768Encapsulate,
  mlkem768Decapsulate,
} from './index';

const seed32 = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const seed64 = (fill: number): Uint8Array => new Uint8Array(64).fill(fill);

describe('X-Wing hybrid KEM (X25519 + ML-KEM-768)', () => {
  it('has the X-Wing draft sizes (proves it is the hybrid, not ML-KEM alone)', () => {
    // pk = ml-kem-768 ek 1184 + x25519 32; ct = ml-kem-768 ct 1088 + x25519 32.
    expect(XWING_LENGTHS).toEqual({
      seed: 32,
      publicKey: 1216,
      cipherText: 1120,
      sharedSecret: 32,
    });
    const kp = xwingKeypairFromSeed(seed32(1));
    expect(kp.publicKey.length).toBe(1216);
    expect(kp.secretKey.length).toBe(32); // seed-sized secret => mnemonic-recoverable
    const enc = xwingEncapsulate(kp.publicKey);
    expect(enc.cipherText.length).toBe(1120);
    expect(enc.sharedSecret.length).toBe(32);
  });

  it('encapsulate/decapsulate round-trips to the same shared secret', () => {
    const kp = xwingKeypairFromSeed(seed32(2));
    const enc = xwingEncapsulate(kp.publicKey);
    const got = xwingDecapsulate(enc.cipherText, kp.secretKey);
    expect(bytesToHex(got)).toBe(bytesToHex(enc.sharedSecret));
  });

  it('is deterministic from the seed (recoverable from the mnemonic)', () => {
    const a = xwingKeypairFromSeed(seed32(3));
    const b = xwingKeypairFromSeed(seed32(3));
    expect(bytesToHex(a.publicKey)).toBe(bytesToHex(b.publicKey));
    expect(bytesToHex(a.secretKey)).toBe(bytesToHex(b.secretKey));
    expect(bytesToHex(xwingPublicKeyFromSeed(seed32(3)))).toBe(bytesToHex(a.publicKey));
  });

  it('different seeds give different keys', () => {
    const a = xwingKeypairFromSeed(seed32(4));
    const b = xwingKeypairFromSeed(seed32(5));
    expect(bytesToHex(a.publicKey)).not.toBe(bytesToHex(b.publicKey));
  });

  it('the wrong secret key does NOT recover the secret (and does not throw - implicit rejection)', () => {
    const alice = xwingKeypairFromSeed(seed32(6));
    const mallory = xwingKeypairFromSeed(seed32(7));
    const enc = xwingEncapsulate(alice.publicKey);
    const wrong = xwingDecapsulate(enc.cipherText, mallory.secretKey);
    expect(wrong.length).toBe(32); // returns pseudo-random bytes, no throw
    expect(bytesToHex(wrong)).not.toBe(bytesToHex(enc.sharedSecret));
  });

  it('a tampered ciphertext does NOT recover the secret (mismatch must fail at the AEAD)', () => {
    const kp = xwingKeypairFromSeed(seed32(8));
    const enc = xwingEncapsulate(kp.publicKey);
    const tampered = Uint8Array.from(enc.cipherText);
    const orig = tampered[0] ?? 0;
    tampered[0] = orig === 0 ? 1 : 0; // flip to a guaranteed-different byte
    const got = xwingDecapsulate(tampered, kp.secretKey);
    expect(bytesToHex(got)).not.toBe(bytesToHex(enc.sharedSecret));
  });

  it('rejects malformed inputs by length', () => {
    expect(() => xwingKeypairFromSeed(new Uint8Array(31))).toThrow(/seed must be 32/);
    expect(() => xwingEncapsulate(new Uint8Array(1215))).toThrow(/publicKey must be 1216/);
    expect(() =>
      xwingDecapsulate(new Uint8Array(1119), xwingKeypairFromSeed(seed32(9)).secretKey),
    ).toThrow(/cipherText must be 1120/);
  });

  it('the suite id is xwing-v1', () => {
    expect(XWING_SUITE).toBe('xwing-v1');
  });

  it('pinned regression: keygen(seed=0x09*32) public key digest is stable', () => {
    // Guards against a silent primitive/version change under us (a noble bump
    // that alters seed expansion would flip this). NOT an interop KAT - both
    // sides of every zafu handshake use this same implementation. If this
    // breaks after an intentional upgrade, every stored contact key rederives,
    // so treat a change as a migration event, not a snapshot update.
    const pk = xwingPublicKeyFromSeed(seed32(9));
    expect(bytesToHex(sha256(pk))).toBe(
      '22572a534ca03a68e5cacdc1ed7527ea136db8793e20138eebb0e5ae2a5e2fb9',
    );
  });
});

describe('raw ML-KEM-768 (Noise channel mix)', () => {
  it('has FIPS 203 sizes', () => {
    expect(MLKEM768_LENGTHS).toEqual({
      seed: 64,
      publicKey: 1184,
      secretKey: 2400,
      cipherText: 1088,
      sharedSecret: 32,
    });
  });

  it('ephemeral keygen round-trips', () => {
    const kp = mlkem768KeygenEphemeral();
    expect(kp.publicKey.length).toBe(1184);
    expect(kp.secretKey.length).toBe(2400);
    const enc = mlkem768Encapsulate(kp.publicKey);
    expect(enc.cipherText.length).toBe(1088);
    const got = mlkem768Decapsulate(enc.cipherText, kp.secretKey);
    expect(bytesToHex(got)).toBe(bytesToHex(enc.sharedSecret));
  });

  it('seeded keygen is deterministic (static keys recoverable from mnemonic)', () => {
    const a = mlkem768KeypairFromSeed(seed64(1));
    const b = mlkem768KeypairFromSeed(seed64(1));
    expect(bytesToHex(a.publicKey)).toBe(bytesToHex(b.publicKey));
  });

  it('ephemeral keygen is NOT deterministic (fresh randomness each call)', () => {
    const a = mlkem768KeygenEphemeral();
    const b = mlkem768KeygenEphemeral();
    expect(bytesToHex(a.publicKey)).not.toBe(bytesToHex(b.publicKey));
  });

  it('wrong secret key -> pseudo-random ss, no throw (implicit rejection)', () => {
    const kp = mlkem768KeypairFromSeed(seed64(2));
    const other = mlkem768KeypairFromSeed(seed64(3));
    const enc = mlkem768Encapsulate(kp.publicKey);
    const wrong = mlkem768Decapsulate(enc.cipherText, other.secretKey);
    expect(bytesToHex(wrong)).not.toBe(bytesToHex(enc.sharedSecret));
  });
});
