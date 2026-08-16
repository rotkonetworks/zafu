/**
 * frostd-client tests.
 *
 * These cover the HTTP shape only — that we call the endpoints the standard
 * defines, with the bodies it expects, and read the responses it returns.
 * The Noise_K encryption lives in wasm (FrostRelayCipher) and is tested in
 * Rust, where it is asserted byte-compatible with ZF's own frost-client.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FrostdClient } from './frostd-client';

const HOST = 'https://relay.example';

/** Capture calls and reply with canned JSON. */
function mockFetch(responses: Record<string, unknown>) {
  const calls: { path: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname.slice(1);
    calls.push({ path, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (!(path in responses)) {
      return new Response('not found', { status: 404 });
    }
    return new Response(JSON.stringify(responses[path]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

describe('FrostdClient', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('logs in by signing the challenge the server issues', async () => {
    const calls = mockFetch({
      challenge: { challenge: '11111111-1111-1111-1111-111111111111' },
      login: { access_token: '22222222-2222-2222-2222-222222222222' },
    });

    const client = new FrostdClient(HOST);
    // signing is the caller's job — the private key never enters this class
    const sign = vi.fn(async () => new Uint8Array(64).fill(7));
    await client.login('aabb', sign);

    expect(calls.map(c => c.path)).toEqual(['challenge', 'login']);
    expect(sign).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
    expect(calls[1]!.body).toMatchObject({
      challenge: '11111111-1111-1111-1111-111111111111',
      pubkey: 'aabb',
    });
  });

  it('sends the access token as a bearer header once logged in', async () => {
    mockFetch({
      challenge: { challenge: 'c' },
      login: { access_token: 'tok' },
      list_sessions: { session_ids: [] },
    });

    const client = new FrostdClient(HOST);
    await client.login('aabb', async () => new Uint8Array(64));
    await client.listSessions();

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const lastInit = fetchMock.mock.calls.at(-1)![1] as RequestInit;
    expect((lastInit.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
  });

  it('refuses to act before login rather than sending an unauthenticated call', async () => {
    mockFetch({ list_sessions: { session_ids: [] } });
    const client = new FrostdClient(HOST);
    await expect(client.listSessions()).rejects.toThrow(/not logged in/i);
  });

  it('creates a session and returns the id the server assigned', async () => {
    mockFetch({
      challenge: { challenge: 'c' },
      login: { access_token: 'tok' },
      create_new_session: { session_id: 'sess-1' },
    });

    const client = new FrostdClient(HOST);
    await client.login('aabb', async () => new Uint8Array(64));
    const id = await client.createSession(['ccdd', 'eeff'], 2);

    expect(id).toBe('sess-1');
  });

  it('surfaces server errors instead of returning undefined', async () => {
    mockFetch({
      challenge: { challenge: 'c' },
      login: { access_token: 'tok' },
    });

    const client = new FrostdClient(HOST);
    await client.login('aabb', async () => new Uint8Array(64));
    // send is not in the mock, so it 404s
    await expect(client.send('sess-1', ['ccdd'], 'deadbeef')).rejects.toThrow(/frostd/i);
  });

  it('passes ciphertext straight through — it never encrypts anything itself', async () => {
    const calls = mockFetch({
      challenge: { challenge: 'c' },
      login: { access_token: 'tok' },
      send: {},
    });

    const client = new FrostdClient(HOST);
    await client.login('aabb', async () => new Uint8Array(64));
    await client.send('sess-1', ['ccdd'], 'ff00ff00');

    expect(calls.at(-1)!.body).toMatchObject({
      session_id: 'sess-1',
      recipients: ['ccdd'],
      msg: 'ff00ff00',
    });
  });

  it('returns received messages with their senders', async () => {
    mockFetch({
      challenge: { challenge: 'c' },
      login: { access_token: 'tok' },
      receive: { msgs: [{ sender: 'ccdd', msg: 'aa11' }] },
    });

    const client = new FrostdClient(HOST);
    await client.login('aabb', async () => new Uint8Array(64));
    const msgs = await client.receive('sess-1', false);

    expect(msgs).toEqual([{ sender: 'ccdd', msg: 'aa11' }]);
  });
});
