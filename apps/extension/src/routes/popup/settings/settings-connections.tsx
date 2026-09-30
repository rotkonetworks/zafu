/**
 * "everything zafu talks to" - a core privacy screen (founder decision,
 * 2026-10), not a folded-away directory. Every known destination gets its
 * own allow/block control, grouped by purpose, tagged "needed for <network>"
 * when it is a shipped chain endpoint for a network the user has enabled,
 * "optional" otherwise (price feeds, the contact-discovery relay, zafu's own
 * relay/license/sponsor hosts, ...). The goal a zcash-only user should reach:
 * nothing optional allowed unless they opted in.
 *
 * This screen only reads/writes the EXISTING egress ledger (net/ledger.ts)
 * and inventory (net/inventory.ts) - the same ones settings-networks-
 * directory.tsx already used for the IBC chains' shipped-host decisions. It
 * does not add enforcement: "needed"/"optional" here is a display label
 * (network membership does not gate the ledger), and the "off by default,
 * opt-in only" rule described above is enforcement a separate change (the
 * egress gate in net/) would need to implement - not built by this screen.
 *
 * Known gap: destinations this screen cannot show, because they are not in
 * the trusted-destination inventory at all (SHIPPED / configuredDestinations
 * in net/inventory.ts) - zcash.me's live-lookup host, and the default voting
 * server (only a user-set OVERRIDE is tracked, not the shipped default). See
 * the task report for the full list.
 */
import { useStore } from '../../../state';
import { selectEnabledNetworks } from '../../../state/keyring';
import { hostOf } from '../../../net/destination';
import type { DestinationState } from '../../../net/destination';
import type { TrustedDestination } from '../../../net/inventory';
import { NET_PURPOSE_LABEL, type NetPurpose } from '../../../net/purpose';
import { ZCASH_MAINNET_ENDPOINTS } from '../../../config/zcash-endpoints';
import { PENUMBRA_MAINNET_ENDPOINTS } from '../../../config/penumbra-endpoints';
import { COSMOS_CHAINS } from '@repo/wallet/networks/cosmos/chains';
import { useDirectoryState } from './settings-networks-directory';
import { SettingsScreen } from './settings-screen';
import { PopupPath } from '../paths';
import { Segmented } from '@repo/ui/components/ui/segmented';
import { cn } from '@repo/ui/lib/utils';

const ZCASH_HOSTS = new Set(
  ZCASH_MAINNET_ENDPOINTS.map(p => hostOf(p.url)).filter((h): h is string => Boolean(h)),
);
const PENUMBRA_HOSTS = new Set(
  [
    ...PENUMBRA_MAINNET_ENDPOINTS.map(p => p.url),
    ...Object.values(COSMOS_CHAINS).flatMap(c => [c.rpcEndpoint, c.restEndpoint]),
  ]
    .map(u => (u ? hostOf(u) : undefined))
    .filter((h): h is string => Boolean(h)),
);

/** display-only: which enabled network this host is shipped for, if any.
 *  Everything else - price feeds, relays, zafu's own service hosts, license,
 *  voting, ota - reads "optional". */
const neededFor = (host: string, enabledNetworks: readonly string[]): string | null => {
  if (ZCASH_HOSTS.has(host) && enabledNetworks.includes('zcash')) {
    return 'zcash';
  }
  if (PENUMBRA_HOSTS.has(host) && enabledNetworks.includes('penumbra')) {
    return 'penumbra';
  }
  return null;
};

export const SettingsConnections = () => {
  const enabledNetworks = useStore(selectEnabledNetworks) as string[];
  const { egress, destinations, decide } = useDirectoryState();

  const grouped = destinations.reduce<Map<NetPurpose, TrustedDestination[]>>((acc, dest) => {
    for (const purpose of dest.purposes.length ? dest.purposes : (['other'] as NetPurpose[])) {
      const list = acc.get(purpose) ?? [];
      list.push(dest);
      acc.set(purpose, list);
    }
    return acc;
  }, new Map());

  return (
    <SettingsScreen title='everything zafu talks to' backPath={PopupPath.SETTINGS_PRIVACY}>
      <div className='flex flex-col gap-5'>
        <p className='text-label text-fg-muted'>
          allow or block each host zafu may contact. needed hosts run the networks you enabled;
          optional ones are relays, price feeds and the like.
        </p>
        {[...grouped.entries()].map(([purpose, list]) => (
          <div key={purpose}>
            <p className='kicker mb-2'>{NET_PURPOSE_LABEL[purpose]}</p>
            <div className='flex flex-col gap-2'>
              {list.map(dest => {
                const state: DestinationState = egress?.destinations[dest.host]?.state ?? 'pending';
                const need = neededFor(dest.host, enabledNetworks);
                return (
                  <div
                    key={`${purpose}-${dest.host}`}
                    className='flex flex-col gap-2 border border-surface-border-soft bg-surface-elev-1 p-3'
                  >
                    <div className='flex items-start justify-between gap-2'>
                      <div className='flex min-w-0 flex-col'>
                        <span className='truncate text-data text-fg-high lowercase'>
                          {dest.label}
                        </span>
                        <span className='truncate font-mono text-label text-fg-dim'>
                          {dest.host}
                        </span>
                      </div>
                      <span
                        className={cn(
                          'shrink-0 text-label lowercase',
                          need ? 'text-fg-muted' : 'text-zigner-gold',
                        )}
                      >
                        {need ? `needed for ${need}` : 'optional'}
                      </span>
                    </div>
                    <Segmented
                      value={state}
                      onChange={next => void decide(dest.host, dest.label, next)}
                      options={[
                        { value: 'pending', label: 'not decided' },
                        { value: 'allowed', label: 'allow' },
                        { value: 'blocked', label: 'block' },
                      ]}
                      label={`${dest.host} decision`}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </SettingsScreen>
  );
};
