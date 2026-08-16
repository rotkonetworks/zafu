/**
 * frostd-relay-client tests.
 *
 * The property that matters: nothing reaches the relay unencrypted. The old
 * client put `SIGN:sighash:alphas:recipient:amount:fee:pczt` on the wire as
 * plaintext while the UI promised the relay "never sees keys or amounts", so
 * that is asserted directly here rather than assumed from the cipher's own
 * unit tests.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FrostdRelayClient, type RelayIdentity } from './frostd-relay-client';

const HOST = 'https://relay.example';
const OUR_KEY = 'aa'.repeat(32);
const PEER_KEY = 'bb'.repeat(32);

/** A stand-in for the wasm cipher: reversible, and obviously not plaintext. */
function fakeCipher() {
  return {
    encrypt: vi.fn((_peer: string, msg: Uint8Array) =>
      'ENC' + [...msg].map(b => (b ^ 0x5a).toString(16).padStart(2, '0')).join(''),
    ),
    decrypt: vi.fn((_sender: string, hex: string) => {
      const body = hex.slice(3);
      const out = new Uint8Array(body.length / 2);
      for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(body.substr(i * 2, 2), 16) ^ 0x5a;
      }
      return out;
    }),
  };
}

function identity(cipher = fakeCipher()): RelayIdentity {
  return {
    publicKey: OUR_KEY,
    sign: async () => new Uint8Array(64),
    peers: [PEER_KEY],
    cipher,
  };
}

function mockFetch(responses: Record<string, unknown>) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname.slice(1);
      calls.push({ path, body: init?.body ? JSON.parse(init.body as string) : {} });
      const r = responses[path];
      if (r === undefined) return new Response('{}', { status: 200 });
      return new Response(JSON.stringify(r), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

describe('FrostdRelayClient', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('creates a session listing every participant, ourselves included', async () => {
    const calls = mockFetch({
      challenge: { challenge: 'c' },
      login: { access_token: 't' },
      create_new_session: { session_id: 'sess-1' },
    });

    const c = new FrostdRelayClient(HOST, identity());
    const room = await c.createRoom(2, 3);

    expect(room.roomCode).toBe('sess-1');
    const created = calls.find(x => x.path === 'create_new_session')!;
    // a coordinator that also signs must be in its own session
    expect(created.body.pubkeys).toEqual([OUR_KEY, PEER_KEY]);
  });

  /// THE test. The relay must never receive the plaintext.
  it('never puts plaintext on the wire', async () => {
    const calls = mockFetch({
      challenge: { challenge: 'c' },
      login: { access_token: 't' },
      create_new_session: { session_id: 'sess-1' },
      send: {},
    });

    const c = new FrostdRelayClient(HOST, identity());
    await c.createRoom(2, 3);

    // exactly the shape the old client sent in the clear
    const secret = 'SIGN:aabb:cc:u1recipient:100000:1000:deadbeef';
    await c.sendMessage('sess-1', new Uint8Array(32), new TextEncoder().encode(secret));

    const sent = calls.filter(x => x.path === 'send');
    expect(sent).toHaveLength(1);
    const wire = JSON.stringify(sent[0]!.body);
    expect(wire).not.toContain('u1recipient');
    expect(wire).not.toContain('100000');
    expect(wire).not.toContain('SIGN:');
    // and something really was sent, so this is not vacuous
    expect(String(sent[0]!.body.msg)).toMatch(/^ENC/);
  });

  it('sends one sealed copy per peer', async () => {
    const calls = mockFetch({
      challenge: { challenge: 'c' },
      login: { access_token: 't' },
      create_new_session: { session_id: 'sess-1' },
      send: {},
    });

    const id = identity();
    id.peers = [PEER_KEY, 'cc'.repeat(32)];
    const c = new FrostdRelayClient(HOST, id);
    await c.createRoom(2, 3);
    await c.sendMessage('sess-1', new Uint8Array(32), new Uint8Array([1, 2, 3]));

    const sent = calls.filter(x => x.path === 'send');
    expect(sent).toHaveLength(2);
    expect(sent.map(s => (s.body.recipients as string[])[0])).toEqual([PEER_KEY, 'cc'.repeat(32)]);
  });

  it('refuses to send before a session exists', async () => {
    mockFetch({ challenge: { challenge: 'c' }, login: { access_token: 't' } });
    const c = new FrostdRelayClient(HOST, identity());
    await expect(
      c.sendMessage('nope', new Uint8Array(32), new Uint8Array([1])),
    ).rejects.toThrow(/not in a session/i);
  });

  it('decrypts what it delivers, and reports the sender', async () => {
    const cipher = fakeCipher();
    const sealed = cipher.encrypt(PEER_KEY, new TextEncoder().encode('C:commitment'));
    mockFetch({
      challenge: { challenge: 'c' },
      login: { access_token: 't' },
      receive: { msgs: [{ sender: PEER_KEY, msg: sealed }] },
    });

    const c = new FrostdRelayClient(HOST, identity(cipher));
    const events: string[] = [];
    const ctrl = new AbortController();

    const done = c.joinRoom('sess-1', new Uint8Array(32), ev => {
      if (ev.type === 'message') {
        events.push(new TextDecoder().decode(ev.message.payload));
        ctrl.abort();
      }
    }, ctrl.signal);

    await done;
    expect(events).toEqual(['C:commitment']);
  });

  /// A message we cannot open must not be handed upward as if it were
  /// plaintext — that would reintroduce exactly what this replaces.
  it('drops undecryptable messages instead of surfacing them raw', async () => {
    const cipher = fakeCipher();
    cipher.decrypt = vi.fn(() => {
      throw new Error('not for us');
    });
    mockFetch({
      challenge: { challenge: 'c' },
      login: { access_token: 't' },
      receive: { msgs: [{ sender: PEER_KEY, msg: 'ENCdeadbeef' }] },
    });

    const c = new FrostdRelayClient(HOST, identity(cipher));
    const seen: string[] = [];
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);

    await c.joinRoom('sess-1', new Uint8Array(32), ev => {
      if (ev.type === 'message') seen.push('LEAKED');
    }, ctrl.signal);

    expect(seen).toEqual([]);
  });
});
