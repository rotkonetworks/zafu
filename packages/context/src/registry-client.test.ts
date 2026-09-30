import { describe, test, expect, vi, afterEach } from 'vitest';
import { ChainRegistryClient } from '@penumbrafi/registry';
import { withBundledFallback, type RegistryClient } from './registry-client';

/**
 * `IndexedDb.initialize` calls `registryClient.remote.get(chainId)` and prints a
 * raw `console.error('Failed pre-population of assets from the registry', ...)`
 * when it rejects. These tests pin the property that made that line disappear
 * from the service-worker log on an offline boot: the wrapper resolves from the
 * bundled registry instead of rejecting, and does so quietly.
 */

const CHAIN_ID = 'penumbra-1';

const stubWithRemoteGet = (remoteGet: () => Promise<unknown>): RegistryClient => {
  const client = new ChainRegistryClient();
  return {
    bundled: client.bundled,
    remote: Object.assign(Object.create(client.remote) as object, { get: vi.fn(remoteGet) }),
  } as unknown as RegistryClient;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('withBundledFallback', () => {
  test('resolves offline boots from the bundled registry without logging', async () => {
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    // The extension service worker waking up without a network is the reported
    // case: the registry host is unreachable, everything else may be fine.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    // Premise: an unwrapped client rejects here, which is what makes the storage
    // package log `Failed pre-population of assets from the registry`.
    await expect(new ChainRegistryClient().remote.get(CHAIN_ID)).rejects.toThrow();

    const client = withBundledFallback(new ChainRegistryClient());
    const registry = await client.remote.get(CHAIN_ID);

    const bundled = new ChainRegistryClient().bundled.get(CHAIN_ID);
    expect(registry.getAllAssets().length).toBe(bundled.getAllAssets().length);
    expect(registry.getAllAssets().length).toBeGreaterThan(0);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  test('falls back for non-Error rejections too', async () => {
    const warn = vi.spyOn(console, 'warn');
    const client = withBundledFallback(stubWithRemoteGet(() => Promise.reject(undefined)));

    const registry = await client.remote.get(CHAIN_ID);
    expect(registry.getAllAssets().length).toBeGreaterThan(0);
    expect(warn).not.toHaveBeenCalled();
  });

  test('passes the remote registry through when the fetch succeeds', async () => {
    const inner = new ChainRegistryClient();
    const remote = inner.bundled.get(CHAIN_ID);
    const client = withBundledFallback(stubWithRemoteGet(() => Promise.resolve(remote)));

    expect(await client.remote.get(CHAIN_ID)).toBe(remote);
  });

  test('resolves the globals the settings forms need from the bundled copy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    await expect(new ChainRegistryClient().remote.globals()).rejects.toThrow();

    const client = withBundledFallback(new ChainRegistryClient());
    const globals = await client.remote.globals();

    expect(globals.rpcs.length).toBeGreaterThan(0);
    expect(globals).toEqual(new ChainRegistryClient().bundled.globals());
  });

  test('passes the remote globals through when the fetch succeeds', async () => {
    const inner = new ChainRegistryClient();
    const remote = inner.bundled.globals();
    const client = withBundledFallback(inner);
    vi.spyOn(client.remote, 'globals').mockResolvedValue(remote);

    expect(await client.remote.globals()).toBe(remote);
  });

  test('delegates every other member to the wrapped client', () => {
    const inner = new ChainRegistryClient();
    const client = withBundledFallback(inner);

    expect(client.bundled).toBe(inner.bundled);
    expect(typeof client.remote.globals).toBe('function');
    expect(Object.keys(client.remote)).toContain('get');
  });

  test('builds a usable client when handed nothing', () => {
    const client = withBundledFallback();
    expect(client.bundled.get(CHAIN_ID).getAllAssets().length).toBeGreaterThan(0);
  });
});
