/**
 * The patched globals, end to end in one realm: a fetch, a socket, an XHR and
 * an EventSource to a destination the table refuses never reach the native
 * implementation, and the refusal is a typed error the UI can read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EgressTable } from './egress-table';

const ALLOW_ZCASH: EgressTable = {
  rules: [{ host: 'zcash.rotko.net', path: '', destination: 'zcash', allow: true }],
  hosts: {},
  adhoc: false,
};

const natives = {
  fetch: globalThis.fetch,
  WebSocket: globalThis.WebSocket,
  EventSource: globalThis.EventSource,
  open: globalThis.XMLHttpRequest.prototype.open,
};

let nativeFetch: ReturnType<typeof vi.fn>;
let sockets: string[];

// vi.resetModules() forgets a realm's module state but not the channel it
// opened: an earlier test's realm would stay on 'zafu-egress' holding its own
// table and answer later tests' requests. Close every channel a test opened.
const NativeBroadcastChannel = globalThis.BroadcastChannel;
let opened: BroadcastChannel[] = [];

beforeEach(() => {
  vi.resetModules();
  opened = [];
  globalThis.BroadcastChannel = class extends NativeBroadcastChannel {
    constructor(name: string) {
      super(name);
      opened.push(this);
    }
  };
  nativeFetch = vi.fn(() => Promise.resolve(new Response('ok')));
  sockets = [];
  globalThis.fetch = nativeFetch as unknown as typeof fetch;
  globalThis.WebSocket = class {
    constructor(url: string | URL) {
      sockets.push(String(url));
    }
  } as unknown as typeof WebSocket;
  globalThis.EventSource = class {
    constructor(url: string | URL) {
      sockets.push(String(url));
    }
  } as unknown as typeof EventSource;
});

afterEach(() => {
  for (const c of opened) c.close();
  globalThis.BroadcastChannel = NativeBroadcastChannel;
  globalThis.fetch = natives.fetch;
  globalThis.WebSocket = natives.WebSocket;
  globalThis.EventSource = natives.EventSource;
  globalThis.XMLHttpRequest.prototype.open = natives.open;
});

const install = async (
  table: EgressTable | undefined,
  realm: 'popup' | 'worker' | 'content-script' = 'popup',
) => {
  const egress = await import('./egress');
  egress.installEgress(realm, table ? { load: () => Promise.resolve(table) } : {});
  await egress.refreshEgress();
  return egress;
};

describe('installEgress', () => {
  it('lets a required destination through and refuses the rest with a typed error', async () => {
    const { isEgressBlocked } = await install(ALLOW_ZCASH);
    await fetch('https://zcash.rotko.net/zidecar.v1.Zidecar/GetTip');
    expect(nativeFetch).toHaveBeenCalledTimes(1);

    const err = await fetch('https://api.coingecko.com/x').catch((e: unknown) => e);
    expect(isEgressBlocked(err)).toBe(true);
    expect(err).toBeInstanceOf(TypeError);
    expect((err as { refusal: unknown }).refusal).toEqual({
      allow: false,
      host: 'api.coingecko.com',
      destination: undefined,
      reason: 'unknown',
    });
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it('refuses the answer of a redirect that landed off-policy', async () => {
    const { isEgressBlocked } = await install(ALLOW_ZCASH);
    const redirected = (url: string) => {
      const r = new Response('secret');
      Object.defineProperty(r, 'redirected', { value: true });
      Object.defineProperty(r, 'url', { value: url });
      return r;
    };
    nativeFetch.mockResolvedValueOnce(redirected('https://tracker.example/landing'));
    const err = await fetch('https://zcash.rotko.net/x').catch((e: unknown) => e);
    expect(isEgressBlocked(err)).toBe(true);
    expect((err as { refusal: { host: string } }).refusal.host).toBe('tracker.example');

    // a redirect that stays on an allowed host is answered as before
    nativeFetch.mockResolvedValueOnce(redirected('https://zcash.rotko.net/y'));
    expect(await (await fetch('https://zcash.rotko.net/x')).text()).toBe('secret');
  });

  it('follows a redirect within a chosen node host, never to another host', async () => {
    const { isEgressBlocked } = await install({
      rules: [
        // a node the person entered with a path: the rule owns only that prefix
        {
          host: 'node.example',
          path: '/penumbra/',
          destination: 'penumbra',
          allow: true,
          node: true,
        },
        { host: 'feed.example', path: '/a/', destination: 'prices', allow: true },
      ],
      hosts: {},
      adhoc: false,
    });
    const redirected = (url: string) => {
      const r = new Response('ok');
      Object.defineProperty(r, 'redirected', { value: true });
      Object.defineProperty(r, 'url', { value: url });
      return r;
    };
    nativeFetch.mockResolvedValueOnce(redirected('https://node.example/v2/penumbra/'));
    expect(await (await fetch('https://node.example/penumbra/x')).text()).toBe('ok');
    // another host is still decided as itself
    nativeFetch.mockResolvedValueOnce(redirected('https://www.node.example/penumbra/x'));
    const err = await fetch('https://node.example/penumbra/x').catch((e: unknown) => e);
    expect(isEgressBlocked(err)).toBe(true);
    // a service that is not a chain node gets no such leeway
    nativeFetch.mockResolvedValueOnce(redirected('https://feed.example/b/'));
    const feed = await fetch('https://feed.example/a/x').catch((e: unknown) => e);
    expect(isEgressBlocked(feed)).toBe(true);
  });

  it('refuses a socket, an event stream and an xhr in their constructors', async () => {
    await install(ALLOW_ZCASH);
    expect(() => new WebSocket('wss://zrelay.rotko.net/ws')).toThrow(/did not contact zrelay/);
    expect(() => new EventSource('https://x.example/stream')).toThrow(/did not contact/);
    const xhr = new XMLHttpRequest();
    expect(() => xhr.open('GET', 'https://x.example/')).toThrow(/did not contact/);
    new WebSocket('wss://zcash.rotko.net/anything');
    expect(sockets).toEqual(['wss://zcash.rotko.net/anything']);
  });

  it('tells listeners what it refused', async () => {
    const { onEgressBlocked } = await install(ALLOW_ZCASH);
    const seen: string[] = [];
    onEgressBlocked(r => seen.push(`${r.host}:${r.reason}`));
    await fetch('https://zcash.me/api').catch(() => undefined);
    expect(seen).toEqual(['zcash.me:unknown']);
  });

  it('never gates what stays on the machine', async () => {
    await install(ALLOW_ZCASH);
    await fetch('chrome-extension://abc/keys/spend_pk.bin');
    await fetch('http://127.0.0.1:5000/apdu');
    expect(nativeFetch).toHaveBeenCalledTimes(2);
  });

  it('refuses everything from a content script', async () => {
    await install(undefined, 'content-script');
    await expect(fetch('https://zcash.rotko.net/x')).rejects.toThrow(/did not contact/);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it('fails closed in a realm that never received a table', async () => {
    vi.useFakeTimers();
    try {
      await install(undefined, 'worker');
      expect(() => new WebSocket('wss://zcash.rotko.net/x')).toThrow();
      const pending = fetch('https://zcash.rotko.net/x').catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(5000);
      expect((await pending) as Error).toMatchObject({ name: 'EgressBlockedError' });
      expect(nativeFetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('follows the table when a storage realm recompiles it', async () => {
    let table = ALLOW_ZCASH;
    const egress = await import('./egress');
    egress.installEgress('popup', { load: () => Promise.resolve(table) });
    await egress.refreshEgress();
    await expect(fetch('https://zcash.me/api')).rejects.toThrow();
    table = { ...ALLOW_ZCASH, hosts: { 'zcash.me': 'allowed' } };
    await egress.refreshEgress();
    await fetch('https://zcash.me/api');
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });
});

describe('send over nym', () => {
  const NYM_TABLE: EgressTable = {
    ...ALLOW_ZCASH,
    rules: [
      ...ALLOW_ZCASH.rules,
      {
        host: 'zcash.rotko.net',
        path: '/zidecar.v1.Zidecar/SendTransaction',
        destination: 'zcash',
        allow: true,
        nym: 'broadcast',
      },
    ],
    nym: true,
  };

  it('fails closed when nym is not reachable: transport-down, nothing sent directly', async () => {
    const { isEgressBlocked } = await install(NYM_TABLE);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const done = fetch('https://zcash.rotko.net/zidecar.v1.Zidecar/SendTransaction', {
        method: 'POST',
      }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      const err = await done;
      expect(isEgressBlocked(err)).toBe(true);
      expect((err as { refusal: { reason: string } }).refusal.reason).toBe('transport-down');
      expect((err as Error).message).toBe("nym isn't reachable right now. nothing was sent.");
      expect(nativeFetch).not.toHaveBeenCalled();
      // the same host's sync is not held by nym
      await fetch('https://zcash.rotko.net/zidecar.v1.Zidecar/GetCompactBlocks');
      expect(nativeFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('send over nym, by JSON-RPC body', () => {
  it('sends a cometbft status directly and holds a broadcast for nym', async () => {
    const { isEgressBlocked } = await install({
      rules: [
        {
          host: 'rpc.example',
          path: '',
          destination: 'noble',
          allow: true,
          nymBody: [['"method"\\s*:\\s*"broadcast_tx_', 'broadcast']],
        },
      ],
      hosts: {},
      adhoc: false,
      nym: true,
    });
    await fetch('https://rpc.example/', { method: 'POST', body: '{"method":"status"}' });
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const done = fetch('https://rpc.example/', {
        method: 'POST',
        body: '{"jsonrpc":"2.0","method": "broadcast_tx_sync","params":{}}',
      }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      const err = await done;
      expect(isEgressBlocked(err)).toBe(true);
      expect((err as { refusal: { nym: string } }).refusal.nym).toBe('broadcast');
      expect(nativeFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('table relay', () => {
  it('serves its table to a worker even when the storage realm is asleep', async () => {
    const egress = await import('./egress');
    egress.installEgress('offscreen');
    const sw = new BroadcastChannel('zafu-egress');
    sw.postMessage({ type: 'table', table: ALLOW_ZCASH });
    await new Promise(r => setTimeout(r, 20));
    sw.close();

    // a worker spawned later asks; the sleeping service worker cannot answer
    const worker = new BroadcastChannel('zafu-egress');
    const reply = new Promise<unknown>(resolve => {
      worker.onmessage = ev => {
        if ((ev.data as { type: string }).type === 'table') resolve(ev.data);
      };
    });
    // ask until the offscreen realm has taken the table in (a slow CI machine
    // can need longer than one fixed wait), then expect exactly that table
    const asking = setInterval(() => worker.postMessage({ type: 'request' }), 20);
    worker.postMessage({ type: 'request' });
    try {
      expect(await reply).toEqual({ type: 'table', table: ALLOW_ZCASH });
    } finally {
      clearInterval(asking);
    }
    worker.close();
  });
});

describe('isEgressBlockedCause', () => {
  it('finds a refusal wrapped by a ConnectError, not just a bare one', async () => {
    const { isEgressBlockedCause, EgressBlockedError } = await import('./egress');
    const refusal = { allow: false, host: 'api.coingecko.com', destination: 'other' } as const;
    const bare = new EgressBlockedError(refusal as never);
    expect(isEgressBlockedCause(bare)).toBe(true);

    const wrapped = new Error('[unknown] network error', { cause: bare });
    expect(isEgressBlockedCause(wrapped)).toBe(true);
  });

  it('does not mistake an ordinary network error for a refusal', async () => {
    const { isEgressBlockedCause } = await import('./egress');
    expect(isEgressBlockedCause(new Error('network error'))).toBe(false);
    expect(isEgressBlockedCause(undefined)).toBe(false);
  });
});
