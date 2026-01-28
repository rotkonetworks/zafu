/**
 * recent addresses state slice
 *
 * tracks addresses used in transactions for quick access
 * and prompting to save as contacts
 */

import type { AllSlices, SliceCreator } from '.';
import type { ExtensionStorage } from '@repo/storage-chrome/base';
import type { LocalStorageState } from '@repo/storage-chrome/local';

export type AddressNetwork = 'penumbra' | 'zcash' | 'cosmos' | 'polkadot' | 'ethereum' | 'bitcoin';

export interface RecentAddress {
  address: string;
  network: AddressNetwork;
  /** for cosmos, which chain */
  chainId?: string;
  /** how many times used */
  useCount: number;
  /** last used timestamp */
  lastUsedAt: number;
  /** first used timestamp */
  firstUsedAt: number;
}

/** threshold for suggesting to save as contact */
const SUGGEST_SAVE_THRESHOLD = 2;

export interface RecentAddressesSlice {
  recentAddresses: RecentAddress[];

  /** record an address usage (call after successful send) */
  recordUsage: (address: string, network: AddressNetwork, chainId?: string) => Promise<void>;

  /** get recent addresses for a network */
  getRecent: (network: AddressNetwork, limit?: number) => RecentAddress[];

  /** get frequently used addresses (above threshold) */
  getFrequent: (network?: AddressNetwork) => RecentAddress[];

  /** get addresses that should be suggested as contacts */
  getSuggestionsForContacts: () => RecentAddress[];

  /** dismiss a suggestion (user declined to save) */
  dismissSuggestion: (address: string) => Promise<void>;

  /** check if an address should prompt for saving */
  shouldSuggestSave: (address: string) => boolean;

  /** addresses user declined to save */
  dismissedSuggestions: Set<string>;
}

export const createRecentAddressesSlice =
  (local: ExtensionStorage<LocalStorageState>): SliceCreator<RecentAddressesSlice> =>
  (set, get) => ({
    recentAddresses: [],
    dismissedSuggestions: new Set(),

    recordUsage: async (address, network, chainId) => {
      const normalized = address.toLowerCase();

      set((state) => {
        const existing = state.recentAddresses.recentAddresses.find(
          (r) => r.address.toLowerCase() === normalized
        );

        if (existing) {
          existing.useCount += 1;
          existing.lastUsedAt = Date.now();
          if (chainId) existing.chainId = chainId;
        } else {
          state.recentAddresses.recentAddresses.push({
            address,
            network,
            chainId,
            useCount: 1,
            lastUsedAt: Date.now(),
            firstUsedAt: Date.now(),
          });
        }
      });

      // persist to storage
      await local.set(
        'recentAddresses' as keyof LocalStorageState,
        get().recentAddresses.recentAddresses as never
      );
    },

    getRecent: (network, limit = 5) => {
      return [...get().recentAddresses.recentAddresses]
        .filter((r) => r.network === network)
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
        .slice(0, limit);
    },

    getFrequent: (network) => {
      let addresses = get().recentAddresses.recentAddresses;
      if (network) {
        addresses = addresses.filter((r) => r.network === network);
      }
      return [...addresses]
        .filter((r) => r.useCount >= SUGGEST_SAVE_THRESHOLD)
        .sort((a, b) => b.useCount - a.useCount);
    },

    getSuggestionsForContacts: () => {
      const { recentAddresses, dismissedSuggestions } = get().recentAddresses;
      const contacts = get().contacts.contacts;

      // get addresses used multiple times that aren't saved as contacts
      return recentAddresses
        .filter((r) => r.useCount >= SUGGEST_SAVE_THRESHOLD)
        .filter((r) => !contacts.some((c) => c.addresses.some((a) => a.address.toLowerCase() === r.address.toLowerCase())))
        .filter((r) => !dismissedSuggestions.has(r.address.toLowerCase()))
        .sort((a, b) => b.useCount - a.useCount);
    },

    dismissSuggestion: async (address) => {
      set((state) => {
        state.recentAddresses.dismissedSuggestions.add(address.toLowerCase());
      });

      // persist dismissed suggestions
      await local.set(
        'dismissedContactSuggestions' as keyof LocalStorageState,
        [...get().recentAddresses.dismissedSuggestions] as never
      );
    },

    shouldSuggestSave: (address) => {
      const normalized = address.toLowerCase();
      const { recentAddresses, dismissedSuggestions } = get().recentAddresses;
      const contacts = get().contacts.contacts;

      // already a contact?
      if (contacts.some((c) => c.addresses.some((a) => a.address.toLowerCase() === normalized))) {
        return false;
      }

      // already dismissed?
      if (dismissedSuggestions.has(normalized)) {
        return false;
      }

      // check usage count
      const recent = recentAddresses.find((r) => r.address.toLowerCase() === normalized);
      return recent ? recent.useCount >= SUGGEST_SAVE_THRESHOLD : false;
    },
  });

// selectors
export const recentAddressesSelector = (state: AllSlices) => state.recentAddresses;
