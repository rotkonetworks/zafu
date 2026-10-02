import { afterEach, describe, expect, it, vi } from 'vitest';

// a fake relay transport: any presence or discovery call would land here
const transport = { publish: vi.fn(), query: vi.fn() };
const transportFactory = vi.fn(() => transport);
vi.mock('./state/contact-discovery-service', () => ({
  runPresencePublish: vi.fn(() => transportFactory()),
  runDiscoveryForScope: vi.fn(() => transportFactory()),
  contactDiscoveryDeps: { transport: transportFactory },
}));

class FakePort {
  private readonly listeners: (() => void)[] = [];
  readonly onDisconnect = { addListener: (l: () => void) => this.listeners.push(l) };
  constructor(readonly name: string) {}
  drop() {
    this.listeners.forEach(l => l());
  }
}

const fakeRuntime = () => {
  const listeners: ((port: FakePort) => void)[] = [];
  return {
    onConnect: { addListener: (l: (port: FakePort) => void) => listeners.push(l) },
    connect: ({ name }: { name: string }) => {
      const port = new FakePort(name);
      listeners.forEach(l => l(port));
      return port;
    },
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('opening the popup', () => {
  it('resumes sync and makes no relay request', async () => {
    const runtime = fakeRuntime();
    const fetchSpy = vi.fn(() => Promise.reject(new Error('no network in this test')));
    vi.stubGlobal('chrome', { runtime });
    vi.stubGlobal('fetch', fetchSpy);
    const { startUiOpenSession } = await import('./ui-open-session');
    const { announceUiOpenPresence } = await import('./state/ui-open-presence');
    const discovery = await import('./state/contact-discovery-service');
    const sync = { resume: vi.fn(), pause: vi.fn() };

    const session = startUiOpenSession(sync);
    announceUiOpenPresence(); // the popup opens
    await new Promise(r => setTimeout(r, 0));

    expect(session.open).toBe(true);
    expect(sync.resume).toHaveBeenCalledOnce();
    expect(discovery.runPresencePublish).not.toHaveBeenCalled();
    expect(transportFactory).not.toHaveBeenCalled();
    expect(transport.publish).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
