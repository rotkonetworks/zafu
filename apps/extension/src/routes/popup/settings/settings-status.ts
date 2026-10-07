import { UserChoice } from '@repo/storage-chrome/records';
import type { AllSlices } from '../../../state';
import type { KeyInfo } from '../../../state/keyring';
import type { ZcashWalletJson } from '../../../state/wallets';
import { NETWORKS } from '../../../config/networks';
import { selectZcashBackend } from '../../../state/networks';
import { ZCASH_BACKENDS } from '../../../state/keyring/zcash-backend';
import { defaultZcashEndpoint } from '../../../config/zcash-endpoints';
import { hostOf } from '../../../net/destination';

/** live one-line status for each settings group, from local state only - nothing here asks a server */

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** self-custody group seats that were never exported. poker tables (hidden) settle and need none;
 *  an airgap seat lives on its signer. */
export const unbackedSeats = (wallets: readonly ZcashWalletJson[]) =>
  wallets.filter(
    w =>
      w.multisig &&
      w.multisig.custody !== 'airgapSigner' &&
      !w.multisig.hidden &&
      !w.multisig.backedUpAt,
  );

export const selectUnbackedSeatCount = (s: AllSlices) =>
  unbackedSeats(Array.isArray(s.wallets.zcashWallets) ? s.wallets.zcashWallets : []).length;

/** a card's line: plain text, and an optional part in the warning tone */
export interface Status {
  text: string;
  warn?: string;
}

export const securityStatus = (unbacked: number, autoLock: string): Status => ({
  text: autoLock === 'off' ? 'auto-lock off' : `auto-lock ${autoLock}`,
  warn: unbacked > 0 ? `${plural(unbacked, 'group seat')} not backed up` : undefined,
});

export const selectConnectedSiteCount = (s: AllSlices) =>
  (Array.isArray(s.connectedSites.knownSites) ? s.connectedSites.knownSites : []).filter(
    r => r.choice === UserChoice.Approved,
  ).length;

/**
 * the zcash settings switched to let a node or an explorer see more. local
 * history is not counted: nobody else sees it.
 */
export const selectZcashOpenings = (s: AllSlices): number => {
  const p = s.privacy.settings;
  const zcash = s.networks.networks.zcash;
  // memo decoys and instant pending exist only on a zidecar node
  const wire = !!ZCASH_BACKENDS[selectZcashBackend(s)].extras;
  return [
    p.explorerLinks === 'open',
    p.zcashTransparentEachBlock,
    wire && zcash.memoSyncStrategy === 'fast',
    wire && zcash.mempoolWatch === 'on',
  ].filter(Boolean).length;
};

/** the host of the zcash node: the one who sees you sync */
export const selectZcashNodeHost = (s: AllSlices): string =>
  hostOf(s.networks.networks.zcash.endpoint || defaultZcashEndpoint().url) ?? 'auto';

/** destinations on: undefined until the policy view is read */
export const networkStatus = (destinations: number | undefined, sites: number): Status => ({
  text: [
    destinations !== undefined && plural(destinations, 'destination') + ' on',
    sites ? `${plural(sites, 'site')} connected` : 'no sites connected',
  ]
    .filter(Boolean)
    .join(' · '),
});

export const zcashStatus = (on: boolean, node: string, openings: number): Status =>
  !on
    ? { text: 'off · turn on under wallets and devices' }
    : openings
      ? { text: `${node} · `, warn: `${plural(openings, 'setting')} less private` }
      : { text: `${node} · private defaults` };

export const peopleStatus = (
  identity: boolean,
  discovery: boolean,
  zcashMe: string | undefined,
): Status => ({
  text: identity
    ? [`discovery ${discovery ? 'on' : 'off'}`, zcashMe && `zcash.me ${zcashMe}`]
        .filter(Boolean)
        .join(' · ')
    : 'zid off',
});

export const displayStatus = (theme: string, hidden: boolean): Status => ({
  text: `${theme} · balances ${hidden ? 'hidden' : 'shown'}`,
});

/** the enabled networks by name */
export const networkNames = (enabled: readonly string[]) =>
  enabled.map(n => NETWORKS[n]?.name.toLowerCase() ?? n);

export const isZigner = (k: KeyInfo) =>
  k.type === 'zigner-zafu' && (k.insensitive['coldSignerType'] ?? 'zigner') === 'zigner';

export const selectZignerPaired = (s: AllSlices) => s.keyRing.keyInfos.some(isZigner);

export const devicesStatus = (
  wallets: number,
  zigner: boolean,
  networks: readonly string[],
): Status => ({
  text: [
    plural(wallets, 'wallet'),
    zigner && 'zigner paired',
    networks.length ? `${networks.join(', ')} on` : 'no networks on',
  ]
    .filter(Boolean)
    .join(' · '),
});
