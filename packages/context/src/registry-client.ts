/**
 * A penumbra chain-registry client that reads from the copy bundled in the
 * extension first, never the network, for every chain the build already
 * ships metadata for.
 *
 * The registry JSON used to be fetched from raw.githubusercontent.com on
 * every cold read (`IndexedDb.initialize`'s pre-population, the IBC
 * destination list, numeraires, the settings forms) - a request zafu's
 * egress policy had to special-case, and one more host in the "everything
 * zafu talks to" list for data this package already ships. `@penumbrafi/
 * registry` vendors the same JSON as `client.bundled`, so there is no reason
 * to ask the network for it: this wrapper reads the bundled copy only.
 *
 * `IndexedDb.initialize` pre-populates asset metadata by calling
 * `registryClient.remote.get(chainId)`, and the storage package catches a
 * rejection internally with a raw
 * `console.error('Failed pre-population of assets from the registry', error)`.
 * Because that catch lives inside `@penumbra-zone/storage`, a caller has no
 * way to downgrade or silence that line: the only lever is to hand it a
 * client that does not throw, and this one has nothing left to fail.
 *
 * A chain the build ships no registry for (a devnet, a new testnet) gets an
 * empty one, not a fetch: its assets show by their own denoms, and never as a
 * mainnet asset that happens to share an id.
 */
import { ChainRegistryClient, Registry } from '@penumbrafi/registry';

export type RegistryClient = InstanceType<typeof ChainRegistryClient>;

/** the build's registry for `chainId`, or an empty one when it ships none */
export const registryOf = (chainId: string, client: RegistryClient = new ChainRegistryClient()) => {
  try {
    return client.bundled.get(chainId);
  } catch {
    return new Registry({ chainId, ibcConnections: [], assetById: {}, numeraires: [] });
  }
};

/**
 * Wrap `client` so `remote.get` resolves from the bundled registry (empty for
 * a chain it does not ship) and `remote.globals` from the bundled copy first.
 * Every other member (`bundled`, …) is the
 * original, inherited unchanged.
 */
export const withBundledFallback = (
  client: RegistryClient = new ChainRegistryClient(),
): RegistryClient => {
  const wrapped = Object.create(client) as RegistryClient;
  Object.defineProperty(wrapped, 'remote', {
    value: Object.create(client.remote),
    writable: true,
    enumerable: true,
    configurable: true,
  });
  // `get` is a class method on the remote client's prototype, so it is
  // non-writable: a plain assignment would throw in strict mode.
  Object.defineProperty(wrapped.remote, 'get', {
    value: (chainId: string) => Promise.resolve(registryOf(chainId, client)),
    writable: true,
    enumerable: true,
    configurable: true,
  });
  // `globals` backs the settings and endpoint forms: resolve from the build,
  // never the network, for the same reason as asset metadata.
  Object.defineProperty(wrapped.remote, 'globals', {
    value: async () => {
      try {
        return client.bundled.globals();
      } catch {
        return client.remote.globals();
      }
    },
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return wrapped;
};
