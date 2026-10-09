/**
 * The tunnel's lifecycle in the offscreen document: started only while nym
 * is on, once however many ask, with a throwaway identity; stopped by
 * terminating the worker and forgetting that identity.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalChannel } from './local-channel.testkit';
import type { NymMessage } from './nym-bridge';

let routing = true;
/** the service worker's plan: false while locked */
let planAllows = true;
const asked: unknown[] = [];
const setup = vi.fn((_opts: Record<string, unknown>): Promise<void> => Promise.resolve());
const mixFetch = vi.fn((): Promise<unknown> => new Promise(() => undefined));
vi.mock('./egress', () => ({
  nymRoutingOn: () => Promise.resolve(routing),
  checkEgress: () => ({ allow: true }),
  EgressBlockedError: Error,
}));
vi.mock('comlink', () => ({ wrap: () => ({ setupMixTunnel: setup, mixFetch }) }));

const spawned: FakeWorker[] = [];
class FakeWorker extends EventTarget {
  terminated = false;
  constructor(
    readonly url: string,
    readonly opts: WorkerOptions,
  ) {
    super();
    spawned.push(this);
    queueMicrotask(() =>
      this.dispatchEvent(Object.assign(new Event('message'), { data: { kind: 'Loaded' } })),
    );
  }
  terminate() {
    this.terminated = true;
  }
}

const deleted: string[] = [];

beforeEach(() => {
  vi.resetModules();
  routing = true;
  planAllows = true;
  asked.length = 0;
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: (m: unknown) => {
        asked.push(m);
        return Promise.resolve(planAllows);
      },
    },
  });
  spawned.length = 0;
  deleted.length = 0;
  setup.mockReset();
  setup.mockImplementation(() => Promise.resolve());
  mixFetch.mockClear();
  vi.stubGlobal('Worker', FakeWorker);
  LocalChannel.closeAll();
  vi.stubGlobal('BroadcastChannel', LocalChannel);
  vi.stubGlobal('indexedDB', {
    deleteDatabase: (name: string) => deleted.push(name),
    databases: () =>
      Promise.resolve([{ name: 'wasm-client-storage-zafu-left' }, { name: 'zafu-zcash' }]),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** what the host says on the channel */
const listen = () => {
  const heard: NymMessage[] = [];
  const peer = new BroadcastChannel('zafu-nym');
  peer.onmessage = (e: MessageEvent<NymMessage>) => heard.push(e.data);
  return { heard, peer };
};

describe('the nym tunnel', () => {
  it('does not start while nym is off, and says down so a waiting request fails at once', async () => {
    routing = false;
    const { heard, peer } = listen();
    const host = await import('./nym-host');
    await host.startNymTunnel();
    expect(spawned).toHaveLength(0);
    expect(host.nymTunnelRunning()).toBe(false);
    await vi.waitFor(() =>
      expect(heard).toContainEqual({ type: 'state', ready: false, down: true }),
    );
    peer.close();
  });

  it("refuses to start while the service worker's plan says down (locked), and says down", async () => {
    planAllows = false;
    const { heard, peer } = listen();
    const host = await import('./nym-host');
    await host.startNymTunnel();
    expect(asked).toEqual([{ type: 'zafu_nym_may_start' }]);
    expect(spawned).toHaveLength(0);
    await vi.waitFor(() =>
      expect(heard).toContainEqual({ type: 'state', ready: false, down: true }),
    );
    // a send's retry asking again while locked starts nothing either
    peer.postMessage({ type: 'start', via: ['zcash'] });
    await vi.waitFor(() => expect(asked).toHaveLength(2));
    expect(spawned).toHaveLength(0);
    peer.close();
  });

  it('a start nym does not carry says nothing while another start is under way', async () => {
    const { heard, peer } = listen();
    const host = await import('./nym-host');
    const carried = host.startNymTunnel('send', ['zcash']);
    routing = false;
    await host.startNymTunnel('swap', ['thorchain']);
    await carried;
    expect(spawned).toHaveLength(1);
    await vi.waitFor(() => expect(heard).toContainEqual({ type: 'state', ready: true }));
    expect(heard).not.toContainEqual({ type: 'state', ready: false, down: true });
    peer.close();
  });

  it('starts one guarded worker however many ask, with a throwaway sealed identity', async () => {
    const host = await import('./nym-host');
    await Promise.all([host.startNymTunnel(), host.startNymTunnel(), host.startNymTunnel()]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.url).toBe('workers/nym-worker.js');
    // the name puts the worker in the `nym` egress realm
    expect(spawned[0]!.opts.name).toBe('zafu-nym');
    const opts = setup.mock.calls[0]![0];
    expect(opts['clientId']).toMatch(/^zafu-[0-9a-f]{16}$/);
    expect(String(opts['storagePassphrase'])).toHaveLength(64);
    expect(opts['forceTls']).toBe(true);
  });

  it('stops by terminating the worker and forgetting its identity; the next start is fresh', async () => {
    const host = await import('./nym-host');
    await host.startNymTunnel();
    const first = setup.mock.calls[0]![0]['clientId'];
    host.stopNymTunnel();
    expect(spawned[0]!.terminated).toBe(true);
    expect(deleted).toContain(`wasm-client-storage-${String(first)}`);
    expect(host.nymTunnelRunning()).toBe(false);

    await host.startNymTunnel();
    expect(spawned).toHaveLength(2);
    expect(setup.mock.calls[1]![0]['clientId']).not.toBe(first);
  });

  it("forgets an identity a closed browser left behind, and nothing of zafu's own", async () => {
    const host = await import('./nym-host');
    await host.startNymTunnel();
    expect(deleted).toEqual(['wasm-client-storage-zafu-left']);
  });

  it('stops when the last window closes (a stop on the channel)', async () => {
    const host = await import('./nym-host');
    await host.startNymTunnel();
    const sw = new BroadcastChannel('zafu-nym');
    sw.postMessage({ type: 'stop' });
    await vi.waitFor(() => expect(spawned[0]!.terminated).toBe(true));
    sw.close();
  });
  it('an idle stop ends a tunnel with nothing inside at once', async () => {
    const host = await import('./nym-host');
    await host.startNymTunnel();
    const sw = new BroadcastChannel('zafu-nym');
    sw.postMessage({ type: 'stop', idle: true });
    await vi.waitFor(() => expect(spawned[0]!.terminated).toBe(true));
    sw.close();
  });

  it('an idle stop waits for the request inside, then ends the tunnel', async () => {
    let answer: (r: unknown) => void = () => undefined;
    mixFetch.mockImplementationOnce(() => new Promise(r => (answer = r)));
    const { heard, peer } = listen();
    const host = await import('./nym-host');
    await host.startNymTunnel();
    peer.postMessage({
      type: 'fetch',
      id: 'c',
      url: 'https://zcash.rotko.net/x',
      init: { method: 'POST', headers: {} },
    });
    await vi.waitFor(() => expect(mixFetch).toHaveBeenCalledTimes(1));
    peer.postMessage({ type: 'stop', idle: true });
    await new Promise(r => setTimeout(r, 0));
    expect(spawned[0]!.terminated).toBe(false);
    answer({ status: 200, statusText: 'ok', headers: [], body: new Uint8Array() });
    await vi.waitFor(() => expect(spawned[0]!.terminated).toBe(true));
    expect(heard).toContainEqual(expect.objectContaining({ type: 'response', id: 'c' }));
    peer.close();
  });

  it('drops a start that is not ready in time and tries a fresh worker and identity', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setup.mockImplementationOnce(() => new Promise(() => undefined));
    const { heard, peer } = listen();
    const host = await import('./nym-host');
    const started = host.startNymTunnel();
    await vi.advanceTimersByTimeAsync(host.START_MS);
    await started;
    expect(spawned).toHaveLength(2);
    expect(spawned[0]!.terminated).toBe(true);
    expect(setup.mock.calls[1]![0]['clientId']).not.toBe(setup.mock.calls[0]![0]['clientId']);
    await vi.waitFor(() => expect(heard).toContainEqual({ type: 'state', ready: true }));
    peer.close();
  });

  it('says it is down after its tries, never more workers than that', async () => {
    setup.mockImplementation(() => Promise.reject(new Error('handshake timed out')));
    const { heard, peer } = listen();
    const host = await import('./nym-host');
    await host.startNymTunnel();
    expect(spawned).toHaveLength(host.START_TRIES);
    expect(spawned.every(w => w.terminated)).toBe(true);
    await vi.waitFor(() =>
      expect(heard).toContainEqual({ type: 'state', ready: false, down: true }),
    );
    peer.close();
  });

  it('a reroute drops the route, fails what was inside it, and starts a fresh one', async () => {
    const { heard, peer } = listen();
    const host = await import('./nym-host');
    await host.startNymTunnel();
    peer.postMessage({
      type: 'fetch',
      id: 'a',
      url: 'https://zcash.rotko.net/x',
      init: { method: 'POST', headers: {} },
    });
    await vi.waitFor(() => expect(mixFetch).toHaveBeenCalledTimes(1));
    // a reroute for a request this tunnel does not hold changes nothing
    peer.postMessage({ type: 'reroute', id: 'other' });
    peer.postMessage({ type: 'reroute', id: 'a' });
    await vi.waitFor(() => expect(spawned).toHaveLength(2));
    expect(spawned[0]!.terminated).toBe(true);
    expect(heard).toContainEqual({
      type: 'failed',
      id: 'a',
      message: 'nym changed route',
      route: true,
    });
    peer.close();
  });
  it('a try the tunnel failed outright drops that route too', async () => {
    const { heard, peer } = listen();
    const host = await import('./nym-host');
    await host.startNymTunnel();
    mixFetch.mockImplementationOnce(() => Promise.reject(new Error('tunnel not ready: Failed')));
    peer.postMessage({
      type: 'fetch',
      id: 'b',
      url: 'https://zcash.rotko.net/x',
      init: { method: 'POST', headers: {} },
    });
    await vi.waitFor(() => expect(spawned).toHaveLength(2));
    expect(spawned[0]!.terminated).toBe(true);
    expect(heard).toContainEqual({
      type: 'failed',
      id: 'b',
      message: 'tunnel not ready: Failed',
      route: true,
    });
    peer.close();
  });
});
