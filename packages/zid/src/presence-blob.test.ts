import { describe, expect, it } from 'vitest';
import { x25519 } from '@noble/curves/ed25519';
import { hexToBytes } from '@noble/hashes/utils';
import {
  sealPresence,
  openPresence,
  encodePresenceRecord,
  decodePresenceRecord,
  PRESENCE_BLOB_VERSION,
  type PresenceDir,
} from './presence-blob';

// pairwise root secret from static-static X25519 DH (as the tag layer derives it)
const priv = (n: number) => new Uint8Array(32).fill(n);
const aPriv = priv(1);
const bPriv = priv(2);
const aPub = x25519.getPublicKey(aPriv);
const bPub = x25519.getPublicKey(bPriv);
const rootAB = x25519.getSharedSecret(aPriv, bPub);
const rootBA = x25519.getSharedSecret(bPriv, aPub);

const APP = 'poker.zk.bot';
const EPOCH = 42;
const DIR: PresenceDir = 'a2b';

const record = () =>
  encodePresenceRecord({ sessionPub: hexToBytes('ab'.repeat(32)), caps: 0x0102 });

describe('presence blob AEAD', () => {
  it('round-trips: peer opens what the publisher sealed (non-interactive, same root)', async () => {
    const pt = record();
    const blob = await sealPresence(rootAB, APP, EPOCH, DIR, pt);
    const opened = await openPresence(rootBA, APP, EPOCH, DIR, blob);
    expect(opened).not.toBeNull();
    expect(Array.from(opened!)).toEqual(Array.from(pt));
  });

  it('emits versioned layout: version ‖ 12-byte nonce ‖ ciphertext+tag', async () => {
    const pt = record();
    const blob = await sealPresence(rootAB, APP, EPOCH, DIR, pt);
    expect(blob[0]).toBe(PRESENCE_BLOB_VERSION);
    // 1 version + 12 nonce + plaintext(35) + 16 tag
    expect(blob.length).toBe(1 + 12 + pt.length + 16);
  });

  it('uses a fresh random nonce each seal (distinct ciphertext for identical input)', async () => {
    const pt = record();
    const b1 = await sealPresence(rootAB, APP, EPOCH, DIR, pt);
    const b2 = await sealPresence(rootAB, APP, EPOCH, DIR, pt);
    expect(Array.from(b1)).not.toEqual(Array.from(b2));
  });

  it('rejects a blob replayed into a different epoch (AAD + KDF epoch binding)', async () => {
    const blob = await sealPresence(rootAB, APP, EPOCH, DIR, record());
    expect(await openPresence(rootBA, APP, EPOCH + 1, DIR, blob)).toBeNull();
  });

  it('returns null on a tampered ciphertext byte', async () => {
    const blob = await sealPresence(rootAB, APP, EPOCH, DIR, record());
    const last = blob.length - 1;
    blob[last] = 255 - blob[last]!; // corrupt the final tag byte
    expect(await openPresence(rootBA, APP, EPOCH, DIR, blob)).toBeNull();
  });

  it('returns null on a tampered nonce byte', async () => {
    const blob = await sealPresence(rootAB, APP, EPOCH, DIR, record());
    blob[1] = 255 - blob[1]!; // corrupt a nonce byte
    expect(await openPresence(rootBA, APP, EPOCH, DIR, blob)).toBeNull();
  });

  it('rejects an unknown version byte', async () => {
    const blob = await sealPresence(rootAB, APP, EPOCH, DIR, record());
    blob[0] = 0x02;
    expect(await openPresence(rootBA, APP, EPOCH, DIR, blob)).toBeNull();
  });

  it('rejects a truncated / undersized blob without throwing', async () => {
    expect(await openPresence(rootBA, APP, EPOCH, DIR, new Uint8Array(5))).toBeNull();
    expect(await openPresence(rootBA, APP, EPOCH, DIR, new Uint8Array(0))).toBeNull();
  });

  it('different app => different key (cross-app open fails)', async () => {
    const blob = await sealPresence(rootAB, APP, EPOCH, DIR, record());
    expect(await openPresence(rootBA, 'dex.rotko.net', EPOCH, DIR, blob)).toBeNull();
  });

  it('different dir => different key (cross-direction open fails)', async () => {
    const blob = await sealPresence(rootAB, APP, EPOCH, 'a2b', record());
    expect(await openPresence(rootBA, APP, EPOCH, 'b2a', blob)).toBeNull();
  });

  it('a different pair cannot open (wrong root secret)', async () => {
    const cPriv = priv(3);
    const rootAC = x25519.getSharedSecret(aPriv, x25519.getPublicKey(cPriv));
    const blob = await sealPresence(rootAB, APP, EPOCH, DIR, record());
    expect(await openPresence(rootAC, APP, EPOCH, DIR, blob)).toBeNull();
  });
});

describe('presence record codec', () => {
  it('round-trips sessionPub + caps', () => {
    const sessionPub = hexToBytes('cd'.repeat(32));
    const enc = encodePresenceRecord({ sessionPub, caps: 0xbeef });
    expect(enc.length).toBe(1 + 32 + 2);
    const dec = decodePresenceRecord(enc);
    expect(dec).not.toBeNull();
    expect(Array.from(dec!.sessionPub)).toEqual(Array.from(sessionPub));
    expect(dec!.caps).toBe(0xbeef);
  });

  it('rejects wrong-length and wrong-version input', () => {
    expect(decodePresenceRecord(new Uint8Array(10))).toBeNull();
    const enc = encodePresenceRecord({ sessionPub: new Uint8Array(32), caps: 0 });
    enc[0] = 0x09;
    expect(decodePresenceRecord(enc)).toBeNull();
  });

  it('throws on a wrong-size sessionPub', () => {
    expect(() => encodePresenceRecord({ sessionPub: new Uint8Array(16), caps: 0 })).toThrow();
  });
});
