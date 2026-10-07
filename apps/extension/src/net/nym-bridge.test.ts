/**
 * The transport filter around a request of a nym class: through the tunnel
 * when it is ready, otherwise refused, never sent directly on its own. A
 * held broadcast goes directly only on a window's answer, for that one send.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NYM_ANSWER_MS, NYM_CHANNEL, NYM_READY_MS, viaNym, type NymMessage } from './nym-bridge';
import { LocalChannel } from './local-channel.testkit';

vi.stubGlobal('BroadcastChannel', LocalChannel);

const URL_SEND = 'https://zcash.rotko.net/zidecar.v1.Zidecar/SendTransaction';

let peer: BroadcastChannel;
let seen: NymMessage[];
const next = vi.fn(() => Promise.resolve(new Response('direct')));
const refuse = vi.fn((): never => {
  throw new TypeError('refused');
});

/** another realm on the channel: the offscreen host, or a window */
const answerWith = (reply: (m: NymMessage) => NymMessage | undefined) =>
  (peer.onmessage = (e: MessageEvent<NymMessage>) => {
    seen.push(e.data);
    const r = reply(e.data);
    if (r) {
      peer.postMessage(r);
    }
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  peer = new BroadcastChannel(NYM_CHANNEL);
  seen = [];
  next.mockClear();
  refuse.mockClear();
});

afterEach(() => {
  peer.close();
  vi.useRealTimers();
});

describe('viaNym', () => {
  it('goes through the tunnel when it is ready, never directly', async () => {
    answerWith(m =>
      m.type === 'ping'
        ? { type: 'state', ready: true }
        : m.type === 'fetch'
          ? {
              type: 'response',
              id: m.id,
              status: 200,
              statusText: 'OK',
              headers: [['grpc-status', '0']],
              body: new TextEncoder().encode('nym'),
            }
          : undefined,
    );
    const res = await viaNym(
      URL_SEND,
      { method: 'POST', body: new Uint8Array([1, 2]) },
      'broadcast',
      next,
      refuse,
    );
    expect(await res.text()).toBe('nym');
    expect(res.headers.get('grpc-status')).toBe('0');
    const sent = seen.find(m => m.type === 'fetch');
    expect(sent).toMatchObject({ url: URL_SEND, init: { method: 'POST' } });
    expect(Array.from(sent?.type === 'fetch' ? sent.init.body! : [])).toEqual([1, 2]);
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses a broadcast when nym is not ready in time and no window answers', async () => {
    answerWith(() => undefined);
    const done = viaNym(URL_SEND, undefined, 'broadcast', next, refuse).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(NYM_READY_MS + NYM_ANSWER_MS);
    expect(await done).toBeInstanceOf(TypeError);
    expect(refuse).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    expect(seen.some(m => m.type === 'held')).toBe(true);
  });

  it('sends a held broadcast directly when a window says so, and leaves the setting alone', async () => {
    const before = await chrome.storage.local.get(null);
    answerWith(m => (m.type === 'held' ? { type: 'answer', id: m.id, direct: true } : undefined));
    const done = viaNym(URL_SEND, undefined, 'broadcast', next, refuse);
    await vi.advanceTimersByTimeAsync(NYM_READY_MS);
    expect(await (await done).text()).toBe('direct');
    expect(next).toHaveBeenCalledTimes(1);
    expect(refuse).not.toHaveBeenCalled();
    expect(await chrome.storage.local.get(null)).toEqual(before);
  });

  it('asks at once when the tunnel says its start failed', async () => {
    answerWith(m =>
      m.type === 'start'
        ? { type: 'state', ready: false, down: true }
        : m.type === 'held'
          ? { type: 'answer', id: m.id, direct: true }
          : undefined,
    );
    const done = viaNym(URL_SEND, undefined, 'broadcast', next, refuse);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await (await done).text()).toBe('direct');
  });

  it("refuses when the window answers don't send", async () => {
    answerWith(m => (m.type === 'held' ? { type: 'answer', id: m.id, direct: false } : undefined));
    const done = viaNym(URL_SEND, undefined, 'broadcast', next, refuse).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(NYM_READY_MS);
    expect(await done).toBeInstanceOf(TypeError);
    expect(next).not.toHaveBeenCalled();
  });

  it('lets the caller stop waiting: an abort rejects at once', async () => {
    answerWith(() => undefined);
    const stop = new AbortController();
    const done = viaNym(URL_SEND, { signal: stop.signal }, 'names-you', next, refuse).catch(
      (e: unknown) => e,
    );
    stop.abort();
    expect((await done) as Error).toMatchObject({ name: 'AbortError' });
    expect(next).not.toHaveBeenCalled();
  });

  it('never offers a lookup of your own transaction directly', async () => {
    answerWith(m => (m.type === 'held' ? { type: 'answer', id: m.id, direct: true } : undefined));
    const done = viaNym(URL_SEND, undefined, 'own-tx', next, refuse).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(NYM_READY_MS);
    expect(await done).toBeInstanceOf(TypeError);
    expect(seen.some(m => m.type === 'held')).toBe(false);
    expect(next).not.toHaveBeenCalled();
  });
});
