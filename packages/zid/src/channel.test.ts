import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { createChannel } from './channel';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** mirrors channel.ts's AEAD associated data for a direction/endpoint/counter. */
const aad = (from: string, to: string, n: number): Uint8Array<ArrayBuffer> =>
  enc.encode(`zid-e2ee:${from}:${to}:${n}`);

/** WebCrypto wants an ArrayBuffer-backed view; noble/hex helpers are typed loosely. */
const buf = (u: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(u);

interface Frame {
  type: string;
  from: string;
  to: string;
  n?: number;
  iv?: string;
  ct?: string;
  dhPub?: string;
  sig?: string;
}

interface TestSession {
  priv: Uint8Array;
  pubkey: string;
  sign: (data: Uint8Array) => Promise<string>;
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  static last(): FakeWebSocket {
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!ws) {
      throw new Error('no WebSocket was constructed');
    }
    return ws;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    // deliberately does not fire onclose: keeps close() side-effect-free in tests
  }
  open(): void {
    this.onopen?.();
  }
  /** returns the handler's own promise, so a test can await the frame's effects. */
  deliver(msg: unknown): Promise<void> | void {
    return this.onmessage?.({ data: JSON.stringify(msg) });
  }
  frames(): Frame[] {
    return this.sent.map(s => JSON.parse(s) as Frame);
  }
}

function sessionFor(seed: number): TestSession {
  const priv = new Uint8Array(32).fill(seed);
  return {
    priv,
    pubkey: bytesToHex(ed25519.getPublicKey(priv)),
    sign: async (data: Uint8Array): Promise<string> => bytesToHex(ed25519.sign(data, priv)),
  };
}

function dhKeypair(seed: number) {
  const priv = new Uint8Array(32).fill(seed);
  return { priv, pub: x25519.getPublicKey(priv) };
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`expected ${what}`);
  }
  return value;
}

/** a peer keyex frame signed with the peer's session key (as the relay would carry it). */
function keyexFrame(peer: TestSession, ourPub: string, dhPubHex: string): unknown {
  return {
    type: 'keyex',
    from: peer.pubkey,
    to: ourPub,
    dhPub: dhPubHex,
    sig: bytesToHex(ed25519.sign(hexToBytes(dhPubHex), peer.priv)),
  };
}

/** replicate the channel's HKDF so the test can decrypt what it sent. */
async function deriveAesKey(
  shared: Uint8Array,
  ourPub: string,
  peerPub: string,
): Promise<CryptoKey> {
  const info = enc.encode(`zid-e2ee:${[ourPub, peerPub].sort().join(':')}`);
  const km = await crypto.subtle.importKey('raw', buf(shared), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info },
    km,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** encrypt a frame as the peer would, in the given direction/counter. */
async function peerWire(
  key: CryptoKey,
  from: string,
  to: string,
  n: number,
  text: string,
): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(from, to, n) },
      key,
      enc.encode(text),
    ),
  );
  return { iv: bytesToHex(iv), ct: bytesToHex(ct) };
}

beforeEach(() => {
  FakeWebSocket.instances.length = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('classical channel - queued sends and readiness', () => {
  it('delivers a send issued before keyex once the key exchange completes', async () => {
    const ours = sessionFor(1);
    const peer = sessionFor(2);
    const peerDh = dhKeypair(3);

    const ch = await createChannel(ours, peer.pubkey, 'ws://relay');
    const ws = FakeWebSocket.last();
    ws.open();

    ch.send('hello-before-keyex');
    expect(ws.frames().some(f => f.type === 'enc')).toBe(false); // queued, not written

    await ws.deliver(keyexFrame(peer, ours.pubkey, bytesToHex(peerDh.pub)));
    await ch.ready;

    const keyex = must(
      ws.frames().find(f => f.type === 'keyex'),
      'our keyex frame',
    );
    const ourDhPub = hexToBytes(must(keyex.dhPub, 'our dh pubkey'));
    const wire = must(
      ws.frames().find(f => f.type === 'enc'),
      'the flushed enc frame',
    );
    const shared = x25519.getSharedSecret(peerDh.priv, ourDhPub);
    const key = await deriveAesKey(shared, ours.pubkey, peer.pubkey);
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: buf(hexToBytes(must(wire.iv, 'iv'))),
        additionalData: aad(ours.pubkey, peer.pubkey, must(wire.n, 'counter')),
      },
      key,
      buf(hexToBytes(must(wire.ct, 'ct'))),
    );
    expect(dec.decode(plain)).toBe('hello-before-keyex');
  });

  it('rejects readiness when no keyex arrives within the deadline', async () => {
    vi.useFakeTimers();
    const ours = sessionFor(11);
    const peer = sessionFor(12);

    const ch = await createChannel(ours, peer.pubkey, 'ws://relay');
    FakeWebSocket.last().open();

    const rejected = expect(ch.ready).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(30_001);
    await rejected;
  });
});

describe('classical channel - replay protection', () => {
  /** bring a channel up and return the peer-side key that decrypts our sends. */
  async function established(ourSeed: number, peerSeed: number, dhSeed: number) {
    const ours = sessionFor(ourSeed);
    const peer = sessionFor(peerSeed);
    const peerDh = dhKeypair(dhSeed);
    const ch = await createChannel(ours, peer.pubkey, 'ws://relay');
    const ws = FakeWebSocket.last();
    ws.open();
    const keyex = must(
      ws.frames().find(f => f.type === 'keyex'),
      'our keyex frame',
    );
    const ourDhPub = hexToBytes(must(keyex.dhPub, 'our dh pubkey'));
    await ws.deliver(keyexFrame(peer, ours.pubkey, bytesToHex(peerDh.pub)));
    await ch.ready;
    const shared = x25519.getSharedSecret(peerDh.priv, ourDhPub);
    const key = await deriveAesKey(shared, ours.pubkey, peer.pubkey);
    return { ours, peer, ch, ws, key };
  }

  it('drops a duplicated enc frame', async () => {
    const { ours, peer, ch, ws, key } = await established(4, 5, 6);
    const got: string[] = [];
    ch.on('message', d => got.push(dec.decode(d)));

    const wire = await peerWire(key, peer.pubkey, ours.pubkey, 0, 'once');
    const frame = {
      type: 'enc',
      from: peer.pubkey,
      to: ours.pubkey,
      n: 0,
      iv: wire.iv,
      ct: wire.ct,
    };
    await ws.deliver(frame);
    expect(got).toEqual(['once']);

    await ws.deliver(frame); // the replay
    expect(got).toEqual(['once']);
  });

  it('refuses to re-key an established channel from a replayed keyex', async () => {
    const { ours, peer, ch, ws, key } = await established(7, 8, 9);
    const got: string[] = [];
    ch.on('message', d => got.push(dec.decode(d)));

    // a valid keyex for a DIFFERENT dh key: honouring it would change the key
    const otherDh = dhKeypair(10);
    await ws.deliver(keyexFrame(peer, ours.pubkey, bytesToHex(otherDh.pub)));

    // the original key still decrypts, so the channel was not re-keyed
    const wire = await peerWire(key, peer.pubkey, ours.pubkey, 0, 'original-key');
    await ws.deliver({
      type: 'enc',
      from: peer.pubkey,
      to: ours.pubkey,
      n: 0,
      iv: wire.iv,
      ct: wire.ct,
    });
    expect(got).toEqual(['original-key']);
  });
});
