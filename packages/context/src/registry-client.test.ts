import { describe, test, expect, vi, afterEach } from 'vitest';
import { ChainRegistryClient } from '@penumbrafi/registry';
import { registryOf, withBundledFallback, type RegistryClient } from './registry-client';

/**
 * `withBundledFallback` resolves from the registry bundled in the extension
 * only - no network, online or offline - and an empty registry for a chain
 * the build does not ship.
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
  test('resolves from the bundled copy without ever calling fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const client = withBundledFallback(new ChainRegistryClient());
    const registry = await client.remote.get(CHAIN_ID);

    const bundled = new ChainRegistryClient().bundled.get(CHAIN_ID);
    expect(registry.getAllAssets().length).toBe(bundled.getAllAssets().length);
    expect(registry.getAllAssets().length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a chain the build ships no registry for is empty, never fetched', async () => {
    const remoteGet = vi.fn(() => Promise.resolve(new ChainRegistryClient().bundled.get(CHAIN_ID)));
    const client = withBundledFallback(stubWithRemoteGet(remoteGet));

    const registry = await client.remote.get('penumbra-testnet-brinance-1');
    expect(registry.chainId).toBe('penumbra-testnet-brinance-1');
    expect(registry.getAllAssets()).toEqual([]);
    expect(remoteGet).not.toHaveBeenCalled();
  });

  test('an unknown chain never shows mainnet metadata for an id it shares', () => {
    const mainnet = registryOf(CHAIN_ID);
    const um = mainnet.getAllAssets().find(m => m.symbol === 'UM')!;
    expect(registryOf('penumbra-testnet-brinance-1').tryGetMetadata(um.penumbraAssetId!)).toBe(
      undefined,
    );
    expect(mainnet.tryGetMetadata(um.penumbraAssetId!)?.symbol).toBe('UM');
  });

  test('resolves the globals the settings forms need from the bundled copy, no fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const client = withBundledFallback(new ChainRegistryClient());
    const globals = await client.remote.globals();

    expect(globals.rpcs.length).toBeGreaterThan(0);
    expect(globals).toEqual(new ChainRegistryClient().bundled.globals());
    expect(fetchSpy).not.toHaveBeenCalled();
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
