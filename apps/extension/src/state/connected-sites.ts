import { ExtensionStorage } from '@repo/storage-chrome/base';
import { LocalStorageState } from '@repo/storage-chrome/local';
import { OriginRecord } from '@repo/storage-chrome/records';
import { Capability } from '@repo/storage-chrome/capabilities';
import { grantCapability, denyCapability, revokeOrigin } from '@repo/storage-chrome/origin';
import { AllSlices, SliceCreator } from '.';

export interface ConnectedSitesSlice {
  filter?: string;
  setFilter: (search?: string) => void;
  knownSites: OriginRecord[];
  discardKnownSite: (originRecord: { origin: string }) => Promise<void>;
  toggleCapability: (origin: string, capability: Capability, enabled: boolean) => Promise<void>;
}

export const createConnectedSitesSlice =
  (_local: ExtensionStorage<LocalStorageState>): SliceCreator<ConnectedSitesSlice> =>
  (set, _get) => ({
    knownSites: [],

    filter: undefined,
    setFilter: (search?: string) => {
      set(state => {
        state.connectedSites.filter = search;
      });
    },

    discardKnownSite: async (siteToDiscard: { origin: string }) => {
      await revokeOrigin(siteToDiscard.origin);
      void chrome.runtime.sendMessage({ revoke: siteToDiscard.origin });
    },

    toggleCapability: async (origin: string, capability: Capability, enabled: boolean) => {
      if (enabled) {
        await grantCapability(origin, capability);
      } else {
        await denyCapability(origin, capability);
      }
    },
  });

export const allSitesFilteredOutSelector = (state: AllSlices) => {
  const filter = state.connectedSites.filter;
  if (!filter) {
    return false;
  }

  const sites = Array.isArray(state.connectedSites.knownSites) ? state.connectedSites.knownSites : [];
  return !sites.some(site => site.origin.includes(filter));
};
