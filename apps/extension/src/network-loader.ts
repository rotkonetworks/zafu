/**
 * Network Loader
 *
 * Manages lazy loading of network adapters based on user's enabled networks.
 * This keeps the initial bundle size small and only loads what the user needs.
 */

import { localExtStorage } from '@repo/storage-chrome/local';
import type { NetworkAdapter } from '@repo/wallet/networks';

export type NetworkId = 'penumbra' | 'zcash' | 'osmosis' | 'noble' | 'nomic' | 'celestia' | 'polkadot' | 'kusama' | 'ethereum' | 'bitcoin';

/** Currently loaded network adapters */
const loadedAdapters = new Map<NetworkId, NetworkAdapter>();

/** Network loading status */
const loadingPromises = new Map<NetworkId, Promise<NetworkAdapter>>();

/**
 * Load a network adapter dynamically
 *
 * Each network's code is only loaded when needed.
 */
async function loadAdapter(network: NetworkId): Promise<NetworkAdapter> {
  // Check if already loading
  const existing = loadingPromises.get(network);
  if (existing) {
    return existing;
  }

  // Check if already loaded
  const loaded = loadedAdapters.get(network);
  if (loaded) {
    return loaded;
  }

  console.log(`[network-loader] loading ${network} adapter`);

  const loadPromise = (async () => {
    let adapter: NetworkAdapter;

    switch (network) {
      case 'penumbra': {
        const { PenumbraAdapter } = await import(
          /* webpackChunkName: "adapter-penumbra" */
          '@repo/wallet/networks/penumbra/adapter'
        );
        adapter = new PenumbraAdapter();
        break;
      }
      case 'zcash': {
        const { ZcashAdapter } = await import(
          /* webpackChunkName: "adapter-zcash" */
          '@repo/wallet/networks/zcash/adapter'
        );
        adapter = new ZcashAdapter();
        break;
      }
      case 'polkadot': {
        const { PolkadotAdapter } = await import(
          /* webpackChunkName: "adapter-polkadot" */
          '@repo/wallet/networks/polkadot/adapter'
        );
        adapter = new PolkadotAdapter();
        break;
      }
      // IBC chains use a shared cosmos adapter
      case 'osmosis':
      case 'noble':
      case 'nomic':
      case 'celestia': {
        const { CosmosAdapter } = await import(
          /* webpackChunkName: "adapter-cosmos" */
          '@repo/wallet/networks/cosmos/adapter'
        );
        adapter = new CosmosAdapter();
        break;
      }
      case 'kusama': {
        // kusama uses same adapter as polkadot
        const { PolkadotAdapter } = await import(
          /* webpackChunkName: "adapter-polkadot" */
          '@repo/wallet/networks/polkadot/adapter'
        );
        adapter = new PolkadotAdapter();
        break;
      }
      case 'ethereum':
      case 'bitcoin':
        // Not yet implemented
        throw new Error(`${network} adapter not yet implemented`);
      default:
        throw new Error(`Unknown network: ${network}`);
    }

    await adapter.initialize();
    loadedAdapters.set(network, adapter);
    loadingPromises.delete(network);

    console.log(`[network-loader] ${network} adapter ready`);
    return adapter;
  })();

  loadingPromises.set(network, loadPromise);
  return loadPromise;
}

/**
 * Unload a network adapter
 *
 * Frees resources when a user disables a network.
 */
async function unloadAdapter(network: NetworkId): Promise<void> {
  const adapter = loadedAdapters.get(network);
  if (adapter) {
    console.log(`[network-loader] unloading ${network} adapter`);
    await adapter.shutdown();
    loadedAdapters.delete(network);
  }
}

/**
 * Get a loaded network adapter
 *
 * Returns undefined if the network is not loaded.
 */
export function getAdapter(network: NetworkId): NetworkAdapter | undefined {
  return loadedAdapters.get(network);
}

/**
 * Get a network adapter, loading it if necessary
 */
export async function getOrLoadAdapter(network: NetworkId): Promise<NetworkAdapter> {
  const existing = loadedAdapters.get(network);
  if (existing) {
    return existing;
  }
  return loadAdapter(network);
}

/**
 * Check if a network adapter is loaded
 */
export function isAdapterLoaded(network: NetworkId): boolean {
  return loadedAdapters.has(network);
}

/**
 * Get all currently loaded adapters
 */
export function getLoadedAdapters(): NetworkAdapter[] {
  return Array.from(loadedAdapters.values());
}

/**
 * Initialize network adapters based on stored preferences
 *
 * Call this on extension startup.
 */
export async function initializeEnabledNetworks(): Promise<void> {
  const enabledNetworks = await localExtStorage.get('enabledNetworks');

  if (!enabledNetworks || enabledNetworks.length === 0) {
    // If no networks explicitly enabled, check for existing wallets
    const wallets = await localExtStorage.get('wallets');
    const zcashWallets = await localExtStorage.get('zcashWallets');
    const zignerWallets = await localExtStorage.get('zignerWallets');

    // Auto-enable networks based on existing wallets
    const networksToEnable: NetworkId[] = [];

    if (wallets && wallets.length > 0) {
      networksToEnable.push('penumbra');
    }
    if (zcashWallets && zcashWallets.length > 0) {
      networksToEnable.push('zcash');
    }
    if (zignerWallets && zignerWallets.length > 0) {
      // Check which networks zigner wallets have
      for (const zw of zignerWallets) {
        if (zw.networks.penumbra && !networksToEnable.includes('penumbra')) {
          networksToEnable.push('penumbra');
        }
        if (zw.networks.zcash && !networksToEnable.includes('zcash')) {
          networksToEnable.push('zcash');
        }
        if (zw.networks.polkadot && !networksToEnable.includes('polkadot')) {
          networksToEnable.push('polkadot');
        }
      }
    }

    // Load the auto-detected networks
    await Promise.all(networksToEnable.map(loadAdapter));

    // Persist the enabled networks
    if (networksToEnable.length > 0) {
      await localExtStorage.set('enabledNetworks', networksToEnable);
    }
  } else {
    // Load explicitly enabled networks
    await Promise.all(enabledNetworks.map(loadAdapter));
  }
}

/**
 * Enable a network (load its adapter)
 */
export async function enableNetwork(network: NetworkId): Promise<void> {
  await loadAdapter(network);

  // Update stored enabled networks
  const current = (await localExtStorage.get('enabledNetworks')) || [];
  if (!current.includes(network)) {
    await localExtStorage.set('enabledNetworks', [...current, network]);
  }
}

/**
 * Disable a network (unload its adapter)
 */
export async function disableNetwork(network: NetworkId): Promise<void> {
  await unloadAdapter(network);

  // Update stored enabled networks
  const current = (await localExtStorage.get('enabledNetworks')) || [];
  await localExtStorage.set('enabledNetworks', current.filter(n => n !== network));
}

/**
 * Listen for storage changes and update adapters accordingly
 */
export function setupNetworkStorageListener(): void {
  localExtStorage.addListener(changes => {
    if (changes.enabledNetworks) {
      const oldNetworks = changes.enabledNetworks.oldValue || [];
      const newNetworks = changes.enabledNetworks.newValue || [];

      // Find networks to load
      const toLoad = newNetworks.filter((n: NetworkId) => !oldNetworks.includes(n));
      // Find networks to unload
      const toUnload = oldNetworks.filter((n: NetworkId) => !newNetworks.includes(n));

      // Load/unload in background
      Promise.all([
        ...toLoad.map((n: NetworkId) => loadAdapter(n).catch(console.error)),
        ...toUnload.map((n: NetworkId) => unloadAdapter(n).catch(console.error)),
      ]).catch(console.error);
    }
  });
}
