import { describe, it, expect } from 'vitest';
import { xwingKeypairFromSeed } from './xwing';
import { sealXWing, openXWing, SEAL_SUITE_XWING } from './sealed';

const seed = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const str = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('hybrid PQ sealed box (X-Wing + AES-256-GCM)', () => {
  it('seals and opens with the recipient seed', () => {
    const s = seed(1);
    const { publicKey } = xwingKeypairFromSeed(s);
    const msg = 'shield this: contact request from poker.zafu.pro';
    const wire = sealXWing(publicKey, utf8(msg));
    expect(wire[0]).toBe(SEAL_SUITE_XWING);
    // suite(1) + xwing_ct(1120) + nonce(12) + gcm(msg + 16 tag)
    expect(wire.length).toBe(1 + 1120 + 12 + utf8(msg).length + 16);
    expect(str(openXWing(s, wire))).toBe(msg);
  });

  it('empty plaintext round-trips', () => {
    const s = seed(2);
    const { publicKey } = xwingKeypairFromSeed(s);
    expect(openXWing(s, sealXWing(publicKey, new Uint8Array(0))).length).toBe(0);
  });

  it('the wrong recipient cannot open it', () => {
    const { publicKey } = xwingKeypairFromSeed(seed(3));
    const wire = sealXWing(publicKey, utf8('secret'));
    expect(() => openXWing(seed(4), wire)).toThrow();
  });

  it('a tampered ciphertext fails to open', () => {
    const s = seed(5);
    const { publicKey } = xwingKeypairFromSeed(s);
    const wire = sealXWing(publicKey, utf8('secret'));
    {
      const i = wire.length - 1;
      wire[i] = (wire[i] ?? 0) === 0 ? 1 : 0;
    } // flip a GCM tag byte
    expect(() => openXWing(s, wire)).toThrow();
  });

  it('a tampered X-Wing ciphertext fails (implicit rejection -> AEAD failure)', () => {
    const s = seed(6);
    const { publicKey } = xwingKeypairFromSeed(s);
    const wire = sealXWing(publicKey, utf8('secret'));
    wire[10] = (wire[10] ?? 0) === 0 ? 1 : 0; // flip a byte in the X-Wing ciphertext
    expect(() => openXWing(s, wire)).toThrow();
  });

  it('two seals of the same message differ (fresh encapsulation each time)', () => {
    const { publicKey } = xwingKeypairFromSeed(seed(7));
    const a = sealXWing(publicKey, utf8('same'));
    const b = sealXWing(publicKey, utf8('same'));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('rejects an unknown suite byte', () => {
    const s = seed(8);
    const { publicKey } = xwingKeypairFromSeed(s);
    const wire = sealXWing(publicKey, utf8('x'));
    wire[0] = 0x02;
    expect(() => openXWing(s, wire)).toThrow(/unknown suite/);
  });
});
