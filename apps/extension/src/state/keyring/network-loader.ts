/**
 * network feature loader - lazy load wasm/features only for enabled networks
 *
 * privacy-first: we don't load network code until user has enabled the network
 * and has at least one key derived for it
 */

import type { NetworkType, NetworkActivation, DerivedKey } from './types';
import { getNetworkActivation, NETWORK_CONFIGS, isPrivacyNetwork } from './types';

type NetworkFeatures = {
  /** is the wasm loaded */
  wasmLoaded: boolean;
  /** network-specific providers */
  providers: Record<string, unknown>;
};

const loadedNetworks = new Map<NetworkType, NetworkFeatures>();

/** check if network features are loaded */
export const isNetworkLoaded = (network: NetworkType): boolean => {
  return loadedNetworks.has(network);
};

/** get loaded features for a network */
export const getNetworkFeatures = (network: NetworkType): NetworkFeatures | undefined => {
  return loadedNetworks.get(network);
};

/** load features for a specific network */
export const loadNetworkFeatures = async (network: NetworkType): Promise<void> => {
  if (loadedNetworks.has(network)) return;

  // privacy networks need special wasm loading
  if (isPrivacyNetwork(network)) {
    switch (network) {
      case 'penumbra':
        // lazy import penumbra wasm - use initWasmWithParallel if available
        try {
          const wasmInit = await import('@penumbra-zone/wasm/init');
          const numThreads = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 4;
          await wasmInit.initWasmWithParallel(numThreads);
          loadedNetworks.set('penumbra', { wasmLoaded: true, providers: {} });
        } catch {
          loadedNetworks.set('penumbra', { wasmLoaded: false, providers: {} });
        }
        break;

      case 'zcash':
        // zcash uses zafu-wasm for key derivation and scanning
        try {
          const { initZcashWasm } = await import('./zcash');
          await initZcashWasm();
          loadedNetworks.set('zcash', { wasmLoaded: true, providers: {} });
        } catch {
          loadedNetworks.set('zcash', { wasmLoaded: false, providers: {} });
        }
        break;
    }
  } else {
    // transparent networks - no wasm needed, just mark as loaded
    // key derivation happens via transparent-networks.ts
    loadedNetworks.set(network, { wasmLoaded: false, providers: {} });
  }
};

/** unload features for a network */
export const unloadNetworkFeatures = (network: NetworkType): void => {
  loadedNetworks.delete(network);
};

/**
 * sync loaded networks with enabled networks
 *
 * call this when:
 * - user enables/disables a network
 * - user adds/removes keys
 */
export const syncNetworkLoading = async (
  enabledNetworks: NetworkType[],
  derivedKeys: DerivedKey[],
): Promise<void> => {
  // get all supported networks from config
  const allNetworks = Object.keys(NETWORK_CONFIGS) as NetworkType[];
  const activations: NetworkActivation[] = allNetworks.map(n =>
    getNetworkActivation(n, enabledNetworks, derivedKeys)
  );

  // load features for networks that should be loaded
  for (const activation of activations) {
    if (activation.shouldLoadFeatures && !loadedNetworks.has(activation.network)) {
      await loadNetworkFeatures(activation.network);
    }
  }

  // unload features for networks that should not be loaded
  for (const [network] of loadedNetworks) {
    const activation = activations.find(a => a.network === network);
    if (!activation?.shouldLoadFeatures) {
      unloadNetworkFeatures(network);
    }
  }
};

/**
 * check if provider should be injected for a network
 *
 * only inject if user has keys AND network is enabled
 */
export const shouldInjectProvider = (
  network: NetworkType,
  enabledNetworks: NetworkType[],
  derivedKeys: DerivedKey[],
): boolean => {
  const activation = getNetworkActivation(network, enabledNetworks, derivedKeys);
  return activation.shouldInjectProvider;
};
