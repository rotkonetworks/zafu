/**
 * A penumbra chain-registry client that cannot fail on a missing network.
 *
 * `IndexedDb.initialize` pre-populates asset metadata by calling
 * `registryClient.remote.get(chainId)`, and the storage package catches that
 * failure internally with a raw
 * `console.error('Failed pre-population of assets from the registry', error)`.
 * The failure is expected in normal operation - a service worker wakes offline,
 * the registry is a public CDN - and because the catch lives inside
 * `@penumbra-zone/storage`, a caller has no way to downgrade or silence that
 * line: the only lever is to hand it a client that does not throw.
 *
 * `remote.getWithBundledBackup` exists for that purpose but warns on every
 * fallback, which is the same noise one level down. This wrapper falls back to
 * the copy of the registry bundled in the extension *silently*: an offline boot
 * or an offline page load simply resolves from data already shipped in the
 * build. The trade-off is accepted deliberately - a genuine remote-registry bug
 * (a parse error, say) is no longer distinguishable from being offline - because
 * asset metadata is advisory, the bundled copy covers the chains we ship, and
 * call sites that need a hard registry failure (onboarding parameter
 * persistence, transaction approval, endpoint hydration) keep their own client
 * and surface it themselves.
 */
import { ChainRegistryClient } from '@penumbrafi/registry';

export type RegistryClient = InstanceType<typeof ChainRegistryClient>;

/**
 * Wrap `client` so the remote reads the pages need offline (`remote.get` for a
 * chain, `remote.globals` for the default endpoints) resolve from the bundled
 * copy when the remote fetch fails. Every other member (`bundled`, …) is the
 * original, inherited unchanged.
 */
export const withBundledFallback = (
  client: RegistryClient = new ChainRegistryClient(),
): RegistryClient => {
  const wrapped: RegistryClient = Object.create(client);
  Object.defineProperty(wrapped, 'remote', {
    value: Object.create(client.remote),
    writable: true,
    enumerable: true,
    configurable: true,
  });
  // `get` is a class method on the remote client's prototype, so it is
  // non-writable: a plain assignment would throw in strict mode.
  Object.defineProperty(wrapped.remote, 'get', {
    value: async (chainId: string) => {
      try {
        return await client.remote.get(chainId);
      } catch {
        return client.bundled.get(chainId);
      }
    },
    writable: true,
    enumerable: true,
    configurable: true,
  });
  // `globals` backs the settings and endpoint forms: offline they should render
  // the endpoints shipped in the build, not an error state, for the same reason
  // as asset metadata.
  Object.defineProperty(wrapped.remote, 'globals', {
    value: async () => {
      try {
        return await client.remote.globals();
      } catch {
        return client.bundled.globals();
      }
    },
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return wrapped;
};
