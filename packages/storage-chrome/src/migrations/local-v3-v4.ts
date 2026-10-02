import type * as FROM from '../versions/v3';
import type * as TO from '../versions/v4';
import { expectVersion, type Migration } from './util';

type MIGRATION = Migration<FROM.VERSION, FROM.LOCAL, TO.VERSION, TO.LOCAL>;

const POLKADOT_NETWORKS = new Set(['polkadot', 'kusama']);

/**
 * Contacts, recent addresses and wallet lists are usually sealed at rest
 * ({ encrypted } boxes the migration cannot open). Only a plain array is
 * filtered; anything else is passed through untouched, never mapped.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T only types `keep` for the caller; the stored value is never trusted as T[]
const filterList = <T>(v: unknown, keep: (x: T) => boolean): unknown =>
  Array.isArray(v) ? (v as T[]).filter(keep) : v;
const mapList = <T>(v: unknown, f: (x: T) => T): unknown =>
  Array.isArray(v) ? (v as T[]).map(f) : v;

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

    const enabledNetworks = filterList<string>(
      old.enabledNetworks,
      n => !POLKADOT_NETWORKS.has(n),
    ) as TO.LOCAL['enabledNetworks'];

    const networkEndpoints =
      old.networkEndpoints && typeof old.networkEndpoints === 'object'
        ? ({
            ...old.networkEndpoints,
            polkadot: undefined,
            kusama: undefined,
          } as TO.LOCAL['networkEndpoints'])
        : old.networkEndpoints;

    const contacts = mapList<{ addresses?: { network: string }[] }>(old.contacts, c => ({
      ...c,
      addresses: filterList<{ network: string }>(
        c.addresses,
        a => !POLKADOT_NETWORKS.has(a.network),
      ) as {
        network: string;
      }[],
    })) as TO.LOCAL['contacts'];

    const recentAddresses = filterList<{ network: string }>(
      old.recentAddresses,
      a => !POLKADOT_NETWORKS.has(a.network),
    ) as TO.LOCAL['recentAddresses'];

    const zignerWallets = mapList<{ networks?: Record<string, unknown> } | null>(
      old.zignerWallets,
      w => {
        if (!w?.networks || typeof w.networks !== 'object') {
          return w;
        }
        const { polkadot, ...networks } = w.networks;
        void polkadot;
        return { ...w, networks };
      },
    ) as TO.LOCAL['zignerWallets'];

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
