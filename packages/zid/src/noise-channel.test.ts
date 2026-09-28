import { afterEach, describe, expect, it, vi } from 'vitest';
import { x25519, ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import {
  initiatorHandshake,
  responderHandshake,
  encryptTransport,
  decryptTransport,
  ctEqual,
  isNoiseHandshakeFailure,
  isNoiseTransportError,
  isNoiseHandshakeTimeoutError,
  encodeProtocolRefusal,
  createNoiseChannel,
  REKEY_EVERY,
  HANDSHAKE_TIMEOUT_MS,
  type CipherState,
  type SessionKey,
} from './noise-channel';
import { openChannel } from './channel-select';

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

/** a real ed25519 session (createNoiseChannel derives its x25519 static from it). */
function edSession() {
  const seed = randomBytes(32);
  const pub = ed25519.getPublicKey(seed);
  const pubkey = bytesToHex(pub);
  return {
    pubkey,
    xPub: ed25519.utils.toMontgomery(pub),
    xPriv: ed25519.utils.toMontgomerySecret(seed),
    session: { pubkey, privkey: seed, sign: async () => '00' } satisfies SessionKey,
  };
}

/** two ed25519 sessions ordered so `lower.pubkey < higher.pubkey` (lower is initiator). */
function orderedPair() {
  const a = edSession();
  const b = edSession();
  return a.pubkey < b.pubkey ? { lower: a, higher: b } : { lower: b, higher: a };
}

/** minimal in-process WebSocket double: a test drives open/message/close itself. */
class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  binaryType = 'blob';
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: Array<string | Uint8Array> = [];

  constructor(readonly url: string) {
    FakeWebSocket.last = this;
  }
  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.();
  }
  /** deliver a binary frame to this side's handler. */
  emit(data: Uint8Array): void {
    this.onmessage?.({ data });
  }
  /** the binary frames this side sent (skips the JSON announce). */
  binarySent(): Uint8Array[] {
    return this.sent.filter((d): d is Uint8Array => typeof d !== 'string');
  }
}

/**
 * createNoiseChannel's runtime channel ALSO emits 'error' (the typed fatal
 * transport error); ZidChannel's type only names the 'message' event.
 */
interface NoiseErrorChannel {
  on(event: 'error', handler: (e: Error) => void): void;
}

/** the stable `name` of a thrown value ('' for a non-Error). */
const errorName = (e: unknown): string => (e instanceof Error ? e.name : '');

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

describe('downgrade eligibility (what channel:auto may fall back on)', () => {
  /** run `fn` and return whatever it threw (so the tag can be inspected). */
  const thrown = (fn: () => unknown): unknown => {
    try {
      fn();
      return null;
    } catch (e) {
      return e;
    }
  };

  it('a wrong-tag frame is MALFORMED, not a downgrade signal', () => {
    const alice = staticKeypair();
    const bob = staticKeypair();
    const hs = initiatorHandshake(alice.priv, alice.pub, bob.pub);
    const notAResp = new Uint8Array(2000);
    notAResp[0] = 0xff;

    const caught = thrown(() => hs.finish(notAResp));
    expect(errorName(caught)).toBe('NoiseMalformedMessageError');
    expect(isNoiseHandshakeFailure(caught)).toBe(false);
  });

  it('a truncated init message is MALFORMED, not a downgrade signal', () => {
    const bob = staticKeypair();
    const short = new Uint8Array(100);
    short[0] = 0x01;

    const caught = thrown(() => responderHandshake(bob.priv, bob.pub, short));
    expect(errorName(caught)).toBe('NoiseMalformedMessageError');
    expect(isNoiseHandshakeFailure(caught)).toBe(false);
  });

  it('an AEAD failure inside the handshake is MALFORMED, not a downgrade signal', () => {
    const alice = staticKeypair();
    const bob = staticKeypair();
    const hs = initiatorHandshake(alice.priv, alice.pub, bob.pub);
    const resp = responderHandshake(bob.priv, bob.pub, hs.message);
    const tampered = Uint8Array.from(resp.message);
    const idx = 1 + 32 + 1088; // inside the encrypted response payload
    tampered[idx] = (tampered[idx] ?? 0) ^ 0xff;

    const caught = thrown(() => hs.finish(tampered));
    expect(errorName(caught)).toBe('NoiseMalformedMessageError');
    expect(isNoiseHandshakeFailure(caught)).toBe(false);
  });

  it('does NOT tag a transport-layer failure - auto must never downgrade for one', () => {
    // the relay is down / the socket errored: a post-handshake transport failure,
    // exactly the case that must propagate rather than become "try classical".
    const cs: CipherState = { k: randomBytes(32), n: 0n };
    const notTransport = new Uint8Array(64);
    notTransport[0] = 0x01;

    const caught = thrown(() => decryptTransport(cs, notTransport));
    expect(caught).toBeInstanceOf(Error);
    expect(isNoiseHandshakeFailure(caught)).toBe(false);
  });
});

describe('transport counter failures are fatal, never silently swallowed (A)', () => {
  /** run `fn` and return whatever it threw. */
  const thrown = (fn: () => unknown): unknown => {
    try {
      fn();
      return null;
    } catch (e) {
      return e;
    }
  };

  it('a replayed or dropped counter is a typed NoiseTransportError', () => {
    const k = randomBytes(32);
    const send: CipherState = { k: k.slice(), n: 0n };
    const recv: CipherState = { k: k.slice(), n: 0n };
    const first = encryptTransport(send, new TextEncoder().encode('one'));
    expect(new TextDecoder().decode(decryptTransport(recv, first))).toBe('one');

    // the relay replays the first frame: the implicit nonce can never resync.
    const replayed = thrown(() => decryptTransport(recv, first));
    expect(isNoiseTransportError(replayed)).toBe(true);
    expect(isNoiseHandshakeFailure(replayed)).toBe(false);

    // a dropped frame (the sender advanced, the receiver did not) is the same class.
    encryptTransport(send, new Uint8Array(1)); // sender n=1: never delivered
    const dropped = thrown(() => decryptTransport(recv, encryptTransport(send, new Uint8Array(1))));
    expect(isNoiseTransportError(dropped)).toBe(true);

    // ...and the failure is reported every time - never swallowed into a wedge.
    expect(isNoiseTransportError(thrown(() => decryptTransport(recv, first)))).toBe(true);
  });

  it('the socket handler closes the channel and hands the caller a typed error', async () => {
    const { lower, higher } = orderedPair();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const errors: Error[] = [];
    const seen: string[] = [];

    const pending = createNoiseChannel(lower.session, higher.pubkey, 'ws://fake');
    const fake = FakeWebSocket.last!;
    fake.open(); // initiator sends its noise_init

    const initMsg = fake.binarySent()[0]!;
    const resp = responderHandshake(higher.xPriv, higher.xPub, initMsg);
    fake.emit(resp.message);

    const channel = await pending;
    channel.on('message', d => seen.push(new TextDecoder().decode(d)));
    // ZidChannel's type only names 'message'; the noise channel also emits 'error'.
    const errorCapable = channel as unknown as NoiseErrorChannel;
    errorCapable.on('error', e => errors.push(e));

    // a legitimate frame is delivered...
    const frame = encryptTransport(resp.sendCS, new TextEncoder().encode('hello'));
    fake.emit(frame);
    expect(seen).toEqual(['hello']);

    // ...then the relay replays it: fatal, surfaced, socket closed.
    fake.emit(frame);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.name).toBe('NoiseTransportError');
    expect(fake.closed).toBe(true);

    // and the dead channel delivers nothing further (no silent half-life).
    fake.emit(encryptTransport(resp.sendCS, new TextEncoder().encode('later')));
    expect(seen).toEqual(['hello']);
  });
});

describe('bounded handshake deadline (B)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('openChannel rejects within a bounded time against a socket that never answers', async () => {
    vi.useFakeTimers();
    const { lower, higher } = orderedPair();
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const pending = openChannel(lower.session, higher.pubkey, 'ws://fake');
    const fake = FakeWebSocket.last!;
    const caughtPromise = pending.then(
      () => null,
      (e: unknown) => e,
    );
    fake.open(); // sends the init and then waits forever

    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS + 1);

    const caught = await caughtPromise;
    expect(caught).toMatchObject({ name: 'NoiseHandshakeTimeoutError' });
    expect(isNoiseHandshakeTimeoutError(caught)).toBe(true);
    // a deadline is a TRANSPORT failure - auto must never downgrade for it.
    expect(isNoiseHandshakeFailure(caught)).toBe(false);
    expect(fake.closed).toBe(true);
  });
});

describe('channel:auto downgrades only on a genuine capability signal (C)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a truncated/garbage responder frame does NOT produce a classical channel', async () => {
    const { lower, higher } = orderedPair();
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const pending = openChannel(lower.session, higher.pubkey, 'ws://fake', 'auto');
    const fake = FakeWebSocket.last!;
    fake.open(); // sends noise_init
    // the relay answers with bytes that are not a valid hybrid resp.
    fake.emit(new Uint8Array([0x02, 0x00, 0x01, 0x02, 0x03, 0x04]));

    const caught = await pending.then(
      () => null,
      (e: unknown) => e,
    );
    // a downgrade would have RESOLVED with a classical channel; we must reject.
    expect(caught).toBeInstanceOf(Error);
    expect(errorName(caught)).toBe('NoiseMalformedMessageError');
    expect(isNoiseHandshakeFailure(caught)).toBe(false);
  });

  it('a malformed refusal frame is NOT a downgrade signal either', async () => {
    const { lower, higher } = orderedPair();
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const pending = openChannel(lower.session, higher.pubkey, 'ws://fake', 'auto');
    const fake = FakeWebSocket.last!;
    fake.open();
    // claims a 64-byte protocol name but carries 3 bytes -> malformed.
    fake.emit(new Uint8Array([0x04, 0x00, 0x40, 0x41, 0x42, 0x43]));

    const caught = await pending.then(
      () => null,
      (e: unknown) => e,
    );
    expect(errorName(caught)).toBe('NoiseMalformedMessageError');
    expect(isNoiseHandshakeFailure(caught)).toBe(false);
  });

  it('a well-formed unknown-protocol refusal still downgrades to classical', async () => {
    const { lower, higher } = orderedPair();
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const pending = openChannel(lower.session, higher.pubkey, 'ws://fake', 'auto');
    const fake = FakeWebSocket.last!;
    fake.open();
    fake.emit(encodeProtocolRefusal('zafuNoise_IK25519_AESGCM_SHA256'));

    const channel = await pending;
    expect(channel.kind).toBe('classical'); // the caller can SEE the downgrade
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
      const wire = encryptTransport(send, new TextEncoder().encode(`m${i}`));
      if (i === 5) {
        epoch0Wire = wire;
      }
      expect(new TextDecoder().decode(decryptTransport(recv, wire))).toBe(`m${i}`);
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
