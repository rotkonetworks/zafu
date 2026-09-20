/**
 * group-chat-channel tests - HTTP shape + session discovery logic, with the
 * real seal (only fetch is mocked). frostd's own contract is covered in
 * frostd-client.test.ts; here we cover chat's use of it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { x25519 } from '@noble/curves/ed25519';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import { GroupChatChannel, CHAT_MESSAGE_COUNT } from './group-chat-channel';
import type { RelayIdentity } from './frostd-relay-client';

const HOST = 'https://relay.example';

const idHex = () => {
  const priv = randomBytes(32);
  return { priv: bytesToHex(priv), pub: bytesToHex(x25519.getPublicKey(priv)) };
};

/** a RelayIdentity whose cipher is never used by chat (seal is separate). */
const relayIdentity = (pub: string, peers: string[]): RelayIdentity => ({
  publicKey: pub,
  peers,
  sign: vi.fn(async () => new Uint8Array(64).fill(1)),
  cipher: { encrypt: () => '', decrypt: () => new Uint8Array() },
});

type Handler = (body: any, n: number) => { status?: number; json?: unknown };

/** a fetch mock whose per-path responses can depend on call order. */
function mockFetch(handlers: Record<string, Handler>) {
  const calls: { path: string; body: any }[] = [];
  const counts: Record<string, number> = {};
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname.slice(1);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ path, body });
    const h = handlers[path];
    if (!h) {
      return new Response('not found', { status: 404 });
    }
    const n = (counts[path] = (counts[path] ?? 0) + 1);
    const r = h(body, n);
    return new Response(r.json === undefined ? '' : JSON.stringify(r.json), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const loginOk: Record<string, Handler> = {
  challenge: () => ({ json: { challenge: 'c-uuid' } }),
  login: () => ({ json: { access_token: 't-uuid' } }),
};

describe('GroupChatChannel.resolveSession', () => {
  beforeEach(() => vi.unstubAllGlobals());

  const alice = idHex();
  const bob = idHex();
  const members = [alice.pub, bob.pub];
  const chan = () => new GroupChatChannel(HOST, relayIdentity(alice.pub, [bob.pub]), alice.priv);

  it('creates a chat session when the group has none', async () => {
    const calls = mockFetch({
      ...loginOk,
      list_sessions: () => ({ json: { session_ids: [] } }),
      create_new_session: () => ({ json: { session_id: 'new-1' } }),
    });

    const id = await chan().resolveSession();
    expect(id).toBe('new-1');
    const create = calls.find(c => c.path === 'create_new_session')!;
    expect(create.body).toMatchObject({ pubkeys: members, message_count: CHAT_MESSAGE_COUNT });
  });

  it('adopts an existing chat session and never creates a second', async () => {
    const calls = mockFetch({
      ...loginOk,
      list_sessions: () => ({ json: { session_ids: ['bbb', 'aaa'] } }),
      get_session_info: body => ({
        json: {
          message_count: CHAT_MESSAGE_COUNT,
          pubkeys: members,
          coordinator_pubkey: alice.pub,
          _echo: body.session_id,
        },
      }),
      create_new_session: () => ({ json: { session_id: 'should-not-happen' } }),
    });

    // lowest id wins so all members converge on the same session
    const id = await chan().resolveSession();
    expect(id).toBe('aaa');
    expect(calls.some(c => c.path === 'create_new_session')).toBe(false);
  });

  it('ignores a signing session with the same members (wrong message_count)', async () => {
    mockFetch({
      ...loginOk,
      list_sessions: () => ({ json: { session_ids: ['sign-1'] } }),
      get_session_info: () => ({
        json: { message_count: 3, pubkeys: members, coordinator_pubkey: alice.pub },
      }),
      create_new_session: () => ({ json: { session_id: 'chat-new' } }),
    });

    const id = await chan().resolveSession();
    expect(id).toBe('chat-new');
  });

  it('trusts a valid cached id without scanning', async () => {
    const calls = mockFetch({
      ...loginOk,
      get_session_info: () => ({
        json: {
          message_count: CHAT_MESSAGE_COUNT,
          pubkeys: members,
          coordinator_pubkey: alice.pub,
        },
      }),
    });

    const id = await chan().resolveSession('cached-1');
    expect(id).toBe('cached-1');
    expect(calls.some(c => c.path === 'list_sessions')).toBe(false);
  });

  it('re-logs in and retries when the access token has expired', async () => {
    const calls = mockFetch({
      ...loginOk,
      // first list_sessions 401s (token expired), second succeeds
      list_sessions: (_b, n) =>
        n === 1 ? { status: 401, json: {} } : { json: { session_ids: [] } },
      create_new_session: () => ({ json: { session_id: 'after-relogin' } }),
    });

    const id = await chan().resolveSession();
    expect(id).toBe('after-relogin');
    // challenge/login happened twice: initial + after the 401
    expect(calls.filter(c => c.path === 'challenge').length).toBe(2);
  });
});

describe('GroupChatChannel send/drain round-trip', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('a frame alice sends is the frame bob opens - across independent channels', async () => {
    const alice = idHex();
    const bob = idHex();
    const members = [alice.pub, bob.pub];
    const SESSION = 'shared-session';

    // one mock acting as a tiny relay: send queues per recipient; only bob
    // drains here, so receive serves bob's queue, tagged with alice as sender
    // the way frostd tags queued messages.
    const queues: Record<string, string[]> = {};
    mockFetch({
      ...loginOk,
      get_session_info: () => ({
        json: {
          message_count: CHAT_MESSAGE_COUNT,
          pubkeys: members,
          coordinator_pubkey: alice.pub,
        },
      }),
      send: body => {
        for (const r of body.recipients as string[]) {
          (queues[r] ??= []).push(body.msg);
        }
        return { json: {} };
      },
      receive: () => ({
        json: { msgs: (queues[bob.pub] ?? []).map(m => ({ sender: alice.pub, msg: m })) },
      }),
    });

    const aliceChan = new GroupChatChannel(HOST, relayIdentity(alice.pub, [bob.pub]), alice.priv);
    const bobChan = new GroupChatChannel(HOST, relayIdentity(bob.pub, [alice.pub]), bob.priv);

    await aliceChan.resolveSession(SESSION);
    await bobChan.resolveSession(SESSION);

    await aliceChan.send(new TextEncoder().encode('gm from alice'));
    const frames = await bobChan.drain();

    expect(frames).toHaveLength(1);
    expect(frames[0]!.senderPub).toBe(alice.pub);
    expect(new TextDecoder().decode(frames[0]!.payload)).toBe('gm from alice');
  });
});
