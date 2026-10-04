import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

class FakePort {
  private readonly listeners: (() => void)[] = [];
  readonly onDisconnect = { addListener: (l: () => void) => this.listeners.push(l) };
  constructor(readonly name: string) {}
  drop() {
    this.listeners.forEach(l => l());
  }
}

/**
 * A runtime whose service worker can restart: every port it holds drops, and
 * a connect made before the new worker has its listener waits for it, as a
 * connect that wakes the worker does.
 */
const fakeRuntime = () => {
  let swListeners: ((port: FakePort) => void)[] = [];
  let open: FakePort[] = [];
  let waiting: FakePort[] = [];
  const connect = vi.fn(({ name }: { name: string }) => {
    const port = new FakePort(name);
    open.push(port);
    if (swListeners.length) {
      swListeners.forEach(l => l(port));
    } else {
      waiting.push(port);
    }
    return port;
  });
  const onConnect = {
    addListener: (l: (port: FakePort) => void) => {
      swListeners.push(l);
      waiting.forEach(l);
      waiting = [];
    },
  };
  const restartWorker = () => {
    swListeners = [];
    const dropped = open;
    open = [];
    dropped.forEach(p => p.drop());
  };
  return { runtime: { connect, onConnect }, restartWorker };
};

/** each realm (the window, each service worker life) gets its own module */
const freshModule = async () => {
  vi.resetModules();
  return import('./ui-open-presence');
};

describe('ui open presence', () => {
  it('a window still counts as open after the service worker restarts', async () => {
    vi.useFakeTimers();
    const fake = fakeRuntime();
    vi.stubGlobal('chrome', { runtime: fake.runtime });
    (await freshModule()).trackUiOpenPresence(
      () => {},
      () => {},
    );
    (await freshModule()).announceUiOpenPresence();

    fake.restartWorker();
    const lastClose = vi.fn();
    (await freshModule()).trackUiOpenPresence(() => {}, lastClose);
    await vi.advanceTimersByTimeAsync(1_000);

    // a second window opens and closes: it is not the last one
    fake.runtime.connect({ name: 'zafu-ui-open' }).drop();
    expect(lastClose).not.toHaveBeenCalled();
  });

  it('backs off while the worker cannot be reached, and reads the error', async () => {
    vi.useFakeTimers();
    let lastErrorReads = 0;
    const ports: FakePort[] = [];
    const runtime = {
      connect: vi.fn(({ name }: { name: string }) => {
        const port = new FakePort(name);
        ports.push(port);
        return port;
      }),
      get lastError() {
        lastErrorReads++;
        return { message: 'Could not establish connection. Receiving end does not exist.' };
      },
    };
    vi.stubGlobal('chrome', { runtime });
    (await freshModule()).announceUiOpenPresence();
    // every connect fails at once, for a minute
    for (let t = 0; t < 60_000; t += 50) {
      ports.splice(0).forEach(p => p.drop());
      await vi.advanceTimersByTimeAsync(50);
    }
    // 500ms doubling to a 30s cap: a handful of tries, never a tight loop
    expect(runtime.connect.mock.calls.length).toBeLessThan(10);
    expect(lastErrorReads).toBe(runtime.connect.mock.calls.length);
  });
});
