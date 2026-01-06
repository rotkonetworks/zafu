/**
 * privacy settings state slice
 *
 * controls opt-in features that may leak metadata through network queries.
 * by default, zafu operates in minimal-footprint mode as a qr bridge for zigner.
 *
 * privacy tiers:
 * 1. shielded (penumbra, zcash) - trial decryption, rpc never learns addresses
 * 2. light client (polkadot) - p2p network, no central rpc, distributed peers
 * 3. transparent (cosmos) - queries specific addresses to centralized rpc
 */

import type { AllSlices, SliceCreator } from '.';
import type { ExtensionStorage } from '@repo/storage-chrome/base';
import type { LocalStorageState } from '@repo/storage-chrome/local';
import type { NetworkType } from '@repo/wallet/networks';

// ============================================================================
// types
// ============================================================================

/**
 * networks where queries are privacy-safe (shielded/encrypted)
 *
 * these use trial decryption - client downloads ALL blocks and
 * decrypts locally with viewing key. RPC never learns which
 * notes/addresses belong to the user.
 *
 * - penumbra: downloads all blocks, decrypts with FVK locally
 * - zcash: zidecar downloads all compact blocks, trial decrypts with IVK
 *          (~3μs per action, privacy-preserving like penumbra)
 */
export const SHIELDED_NETWORKS: NetworkType[] = ['penumbra', 'zcash'];

/**
 * networks using light client (p2p, no centralized rpc)
 *
 * uses smoldot embedded light client for trustless verification.
 * connects to p2p network directly, verifies headers cryptographically.
 * queries are distributed across peers - harder to correlate than single rpc.
 *
 * - polkadot: smoldot light client, no rpc option
 */
export const LIGHT_CLIENT_NETWORKS: NetworkType[] = ['polkadot'];

/**
 * networks where queries leak address activity to centralized rpc
 *
 * these query specific addresses - RPC learns which addresses
 * are being watched, can correlate with IP and timing.
 *
 * - cosmos: transparent, queries specific bech32 addresses
 */
export const TRANSPARENT_NETWORKS: NetworkType[] = ['cosmos'];

export interface PrivacySettings {
  /**
   * enable balance fetching for transparent networks
   * when false (default): no balance queries for polkadot/cosmos
   * when true: fetches balances (leaks address activity to rpc nodes)
   *
   * note: penumbra and zcash always safe (trial decryption, no leak)
   */
  enableTransparentBalances: boolean;

  /**
   * enable transaction history for transparent networks
   * when false (default): no history stored or fetched
   * when true: queries and stores tx history locally
   */
  enableTransactionHistory: boolean;

  /**
   * enable background sync for transparent networks
   * when false (default): no background network activity
   * when true: periodically syncs state with network
   *
   * note: penumbra and zcash sync always safe (shielded)
   */
  enableBackgroundSync: boolean;

  /**
   * enable price fetching (affects all networks)
   * when false (default): no fiat price queries
   * when true: fetches prices from external apis
   *
   * note: price apis don't know your addresses, relatively safe
   */
  enablePriceFetching: boolean;
}

export interface PrivacySlice {
  /** current privacy settings */
  settings: PrivacySettings;

  /** update a single setting */
  setSetting: <K extends keyof PrivacySettings>(
    key: K,
    value: PrivacySettings[K],
  ) => Promise<void>;

  /** reset all settings to privacy-maximizing defaults */
  resetToDefaults: () => Promise<void>;

  /** check if any leaky features are enabled */
  hasLeakyFeatures: () => boolean;
}

// ============================================================================
// defaults - maximum privacy for transparent networks
// ============================================================================

const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  enableTransparentBalances: false,
  enableTransactionHistory: false,
  enableBackgroundSync: false,
  enablePriceFetching: false, // safe but off by default
};

// ============================================================================
// slice creator
// ============================================================================

export const createPrivacySlice =
  (local: ExtensionStorage<LocalStorageState>): SliceCreator<PrivacySlice> =>
  (set, get) => ({
    settings: { ...DEFAULT_PRIVACY_SETTINGS },

    setSetting: async (key, value) => {
      set((state) => {
        state.privacy.settings[key] = value;
      });

      const settings = get().privacy.settings;
      await local.set('privacySettings' as keyof LocalStorageState, settings as never);
    },

    resetToDefaults: async () => {
      set((state) => {
        state.privacy.settings = { ...DEFAULT_PRIVACY_SETTINGS };
      });

      await local.set(
        'privacySettings' as keyof LocalStorageState,
        DEFAULT_PRIVACY_SETTINGS as never,
      );
    },

    hasLeakyFeatures: () => {
      const { settings } = get().privacy;
      return (
        settings.enableTransparentBalances ||
        settings.enableTransactionHistory ||
        settings.enableBackgroundSync
      );
    },
  });

// ============================================================================
// selectors
// ============================================================================

export const privacySelector = (state: AllSlices) => state.privacy;

export const privacySettingsSelector = (state: AllSlices) => state.privacy.settings;

/**
 * check if we can fetch balances for a given network
 * - shielded (penumbra, zcash): always allowed (trial decryption)
 * - light client (polkadot): always allowed (p2p, no central rpc)
 * - transparent (cosmos): only if enableTransparentBalances is true
 */
export const canFetchBalancesForNetwork = (state: AllSlices, network: NetworkType) => {
  if (SHIELDED_NETWORKS.includes(network)) {
    return true; // trial decryption, rpc never learns addresses
  }
  if (LIGHT_CLIENT_NETWORKS.includes(network)) {
    return true; // p2p network, no central rpc to leak to
  }
  return state.privacy.settings.enableTransparentBalances;
};

export const canFetchTransparentBalances = (state: AllSlices) =>
  state.privacy.settings.enableTransparentBalances;

export const canFetchHistory = (state: AllSlices) =>
  state.privacy.settings.enableTransactionHistory;

/**
 * check if we can background sync for a given network
 * - shielded (penumbra, zcash): always allowed (trial decryption)
 * - light client (polkadot): always allowed (p2p, no central rpc)
 * - transparent (cosmos): only if enableBackgroundSync is true
 */
export const canBackgroundSyncForNetwork = (state: AllSlices, network: NetworkType) => {
  if (SHIELDED_NETWORKS.includes(network)) {
    return true; // trial decryption, rpc never learns addresses
  }
  if (LIGHT_CLIENT_NETWORKS.includes(network)) {
    return true; // p2p network, no central rpc to leak to
  }
  return state.privacy.settings.enableBackgroundSync;
};

export const canFetchPrices = (state: AllSlices) =>
  state.privacy.settings.enablePriceFetching;
