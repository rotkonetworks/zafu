/**
 * The tunnel's lifecycle in the offscreen document: started only while nym
 * is on, once however many ask, with a throwaway identity; stopped by
 * terminating the worker and forgetting that identity.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalChannel } from './local-channel.testkit';

let routing = true;
const setup = vi.fn((_opts: Record<string, unknown>) => Promise.resolve());
vi.mock('./egress', () => ({
  nymRoutingOn: () => Promise.resolve(routing),
  checkEgress: () => ({ allow: true }),
  EgressBlockedError: Error,
}));
vi.mock('comlink', () => ({ wrap: () => ({ setupMixTunnel: setup }) }));

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
  spawned.length = 0;
  deleted.length = 0;
  setup.mockClear();
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('BroadcastChannel', LocalChannel);
  vi.stubGlobal('indexedDB', {
    deleteDatabase: (name: string) => deleted.push(name),
    databases: () =>
      Promise.resolve([{ name: 'wasm-client-storage-zafu-left' }, { name: 'zafu-zcash' }]),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('the nym tunnel', () => {
  it('does not start while nym is off', async () => {
    routing = false;
    const host = await import('./nym-host');
    await host.startNymTunnel();
    expect(spawned).toHaveLength(0);
    expect(host.nymTunnelRunning()).toBe(false);
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
});
