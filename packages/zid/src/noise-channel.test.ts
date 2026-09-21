import { describe, it, expect } from 'vitest';
import { x25519 } from '@noble/curves/ed25519';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import {
  initiatorHandshake,
  responderHandshake,
  encryptTransport,
  decryptTransport,
  ctEqual,
  REKEY_EVERY,
  type CipherState,
} from './noise-channel';

/** an x25519 static keypair (the handshake works on x25519 keys directly). */
function staticKeypair() {
  const priv = x25519.utils.randomSecretKey();
  return { priv, pub: x25519.getPublicKey(priv) };
}

/** drive a full initiator<->responder handshake in-loopback (no relay). */
function handshake() {
  const alice = staticKeypair(); // initiator
  const bob = staticKeypair(); // responder
  const hs = initiatorHandshake(alice.priv, alice.pub, bob.pub);
  const resp = responderHandshake(bob.priv, bob.pub, hs.message);
  const initCS = hs.finish(resp.message);
  return { alice, bob, init: hs, initCS, resp };
}

describe('hybrid PQ Noise IK handshake (X25519 + ML-KEM-768)', () => {
  it('both sides derive matching transport keys', () => {
    const { initCS, resp } = handshake();
    // initiator send == responder recv, and vice versa
    expect(bytesToHex(initCS.sendCS.k)).toBe(bytesToHex(resp.recvCS.k));
    expect(bytesToHex(initCS.recvCS.k)).toBe(bytesToHex(resp.sendCS.k));
    // the two directions use independent keys
    expect(bytesToHex(initCS.sendCS.k)).not.toBe(bytesToHex(initCS.recvCS.k));
  });

  it('messages round-trip both directions', () => {
    const { initCS, resp } = handshake();
    const a2b = new TextEncoder().encode('shielded hello from alice');
    const wire1 = encryptTransport(initCS.sendCS, a2b);
    expect(new TextDecoder().decode(decryptTransport(resp.recvCS, wire1))).toBe(
      'shielded hello from alice',
    );
    const b2a = new TextEncoder().encode('hi back from bob');
    const wire2 = encryptTransport(resp.sendCS, b2a);
    expect(new TextDecoder().decode(decryptTransport(initCS.recvCS, wire2))).toBe(
      'hi back from bob',
    );
  });

  it('the responder learns the initiator static key', () => {
    const { alice, resp } = handshake();
    expect(bytesToHex(resp.remoteXPub)).toBe(bytesToHex(alice.pub));
  });

  it('the wire carries the ML-KEM material at the expected sizes', () => {
    const alice = staticKeypair();
    const bob = staticKeypair();
    const hs = initiatorHandshake(alice.priv, alice.pub, bob.pub);
    // 0x01 + e(32) + mlkem_ek(1184) + encStatic(48) + encPayload(16)
    expect(hs.message.length).toBe(1 + 32 + 1184 + 48 + 16);
    expect(hs.message[0]).toBe(0x01);
    const resp = responderHandshake(bob.priv, bob.pub, hs.message);
    // 0x02 + e(32) + mlkem_ct(1088) + encPayload(16)
    expect(resp.message.length).toBe(1 + 32 + 1088 + 16);
    expect(resp.message[0]).toBe(0x02);
  });

  it('two runs derive different keys (fresh ephemerals - forward secrecy)', () => {
    const a = handshake();
    const b = handshake();
    expect(bytesToHex(a.initCS.sendCS.k)).not.toBe(bytesToHex(b.initCS.sendCS.k));
  });

  it('tampering the ML-KEM ciphertext breaks the handshake (bound into the transcript)', () => {
    const alice = staticKeypair();
    const bob = staticKeypair();
    const hs = initiatorHandshake(alice.priv, alice.pub, bob.pub);
    const resp = responderHandshake(bob.priv, bob.pub, hs.message);
    const tampered = Uint8Array.from(resp.message);
    // flip a byte inside the ML-KEM ciphertext region (after 0x02 + e(32))
    const idx = 1 + 32 + 10;
    tampered[idx] = (tampered[idx] ?? 0) === 0 ? 1 : 0;
    expect(() => hs.finish(tampered)).toThrow();
  });

  it('rejects a truncated init message up front (clean length guard)', () => {
    const bob = staticKeypair();
    const short = new Uint8Array(100);
    short[0] = 0x01;
    expect(() => responderHandshake(bob.priv, bob.pub, short)).toThrow(/too short/);
  });

  it('rejects a truncated resp message up front (clean length guard)', () => {
    const alice = staticKeypair();
    const bob = staticKeypair();
    const hs = initiatorHandshake(alice.priv, alice.pub, bob.pub);
    const short = new Uint8Array(100);
    short[0] = 0x02;
    expect(() => hs.finish(short)).toThrow(/too short/);
  });

  it('C1: responder can detect an unexpected initiator (peer authentication)', () => {
    // Bob (responder) expects to talk to Alice, but Mallory - an active party on
    // the untrusted relay - sends a well-formed init with HER own static key.
    const bob = staticKeypair();
    const alice = staticKeypair(); // the peer Bob expects
    const mallory = staticKeypair(); // active attacker
    const evilInit = initiatorHandshake(mallory.priv, mallory.pub, bob.pub).message;
    const result = responderHandshake(bob.priv, bob.pub, evilInit);
    // responderHandshake itself completes - authenticating the peer is the
    // caller's (createNoiseChannel's) job, which compares the decrypted initiator
    // static against the expected peer with ctEqual and rejects on mismatch:
    expect(bytesToHex(result.remoteXPub)).toBe(bytesToHex(mallory.pub));
    expect(ctEqual(result.remoteXPub, alice.pub)).toBe(false); // != expected -> channel rejects
    expect(ctEqual(result.remoteXPub, mallory.pub)).toBe(true);
    // and the genuine peer passes:
    const goodInit = initiatorHandshake(alice.priv, alice.pub, bob.pub).message;
    const good = responderHandshake(bob.priv, bob.pub, goodInit);
    expect(ctEqual(good.remoteXPub, alice.pub)).toBe(true);
  });

  it('a classical-only responder cannot complete (fails closed, no downgrade)', () => {
    // a message missing the ML-KEM ek is the wrong length -> responder rejects
    const alice = staticKeypair();
    const bob = staticKeypair();
    const hs = initiatorHandshake(alice.priv, alice.pub, bob.pub);
    const classicalShaped = hs.message.slice(0, 1 + 32 + 48 + 16); // ek stripped
    expect(() => responderHandshake(bob.priv, bob.pub, classicalShaped)).toThrow();
  });
});

describe('transport symmetric ratchet (P3 Layer 1 forward secrecy)', () => {
  it('round-trips across a rekey boundary and protects pre-ratchet messages', () => {
    const k = randomBytes(32);
    const send: CipherState = { k: k.slice(), n: 0n };
    const recv: CipherState = { k: k.slice(), n: 0n };
    const N = Number(REKEY_EVERY);

    // send one full epoch + into the next; capture an epoch-0 ciphertext.
    let epoch0Wire: Uint8Array | null = null;
    for (let i = 0; i <= N; i++) {
      const wire = encryptTransport(send, new TextEncoder().encode('m' + i));
      if (i === 5) epoch0Wire = wire;
      expect(new TextDecoder().decode(decryptTransport(recv, wire))).toBe('m' + i);
    }

    // recv.k has ratcheted to epoch 1 (it crossed the boundary at counter N).
    // An attacker who compromises the CURRENT (epoch-1) key cannot read the
    // earlier epoch-0 message - the old key was one-way-ratcheted away.
    const stale: CipherState = { k: recv.k.slice(), n: 5n };
    expect(() => decryptTransport(stale, epoch0Wire!)).toThrow();
  });

  it('the key actually changes at the boundary', () => {
    const k = randomBytes(32);
    const send: CipherState = { k: k.slice(), n: 0n };
    const before = bytesToHex(send.k);
    for (let i = 0; i < Number(REKEY_EVERY) + 1; i++) {
      encryptTransport(send, new TextEncoder().encode('x'));
    }
    expect(bytesToHex(send.k)).not.toBe(before);
  });
});
