import type * as FROM from '../versions/v3';
import type * as TO from '../versions/v4';
import { expectVersion, type Migration } from './util';

type MIGRATION = Migration<FROM.VERSION, FROM.LOCAL, TO.VERSION, TO.LOCAL>;

const POLKADOT_NETWORKS = new Set(['polkadot', 'kusama']);

/**
 * v3 -> v4: drop Polkadot/Kusama/Substrate support.
 *
 * This is a filter, not a vault deletion: a zigner vault that also holds
 * zcash/penumbra/cosmos capabilities keeps every one of them, only the
 * polkadot-only fields are stripped from it. A vault that was polkadot-only
 * is left in place (empty of network capabilities) - the existing orphaned
 * vault UX lets the user remove it, the migration never deletes data the
 * user didn't ask to lose.
 *
 * Fields dropped entirely: `polkadotZignerAccounts`,
 * `activePolkadotZignerIndex`, `enabledParachains`, `customChainspecs`,
 * `polkadotVaultSettings`. Fields filtered in place: `activeNetwork`,
 * `enabledNetworks`, `networkEndpoints`, `contacts[].addresses`,
 * `recentAddresses`, `zignerWallets[].networks.polkadot`.
 */
export default {
  version: v => expectVersion(v, 3, 4),
  transform: old => {
    const { polkadotZignerAccounts, activePolkadotZignerIndex, ...rest } = old as FROM.LOCAL &
      Record<string, unknown>;
    void polkadotZignerAccounts;
    void activePolkadotZignerIndex;

    const activeNetwork = (
      old.activeNetwork && POLKADOT_NETWORKS.has(old.activeNetwork) ? undefined : old.activeNetwork
    ) as TO.LOCAL['activeNetwork'];

    const enabledNetworks = old.enabledNetworks?.filter(
      n => !POLKADOT_NETWORKS.has(n),
    ) as TO.LOCAL['enabledNetworks'];

    const networkEndpoints = old.networkEndpoints
      ? ({
          ...old.networkEndpoints,
          polkadot: undefined,
          kusama: undefined,
        } as TO.LOCAL['networkEndpoints'])
      : old.networkEndpoints;

    const contacts = old.contacts?.map(c => ({
      ...c,
      addresses: c.addresses.filter(a => !POLKADOT_NETWORKS.has(a.network)),
    })) as TO.LOCAL['contacts'];

    const recentAddresses = old.recentAddresses?.filter(
      a => !POLKADOT_NETWORKS.has(a.network),
    ) as TO.LOCAL['recentAddresses'];

    const zignerWallets = old.zignerWallets?.map(w => {
      const { polkadot, ...networks } = w.networks;
      void polkadot;
      return { ...w, networks };
    });

    return {
      ...(rest as unknown as TO.LOCAL),
      activeNetwork,
      enabledNetworks,
      networkEndpoints,
      contacts,
      recentAddresses,
      zignerWallets,
      enabledParachains: undefined,
      customChainspecs: undefined,
      polkadotVaultSettings: undefined,
      // required keys must be defined for the storage defaults to line up
      penumbraWallets: old.penumbraWallets ?? [],
      knownSites: old.knownSites ?? [],
      numeraires: old.numeraires ?? [],
    };
  },
} satisfies MIGRATION;
