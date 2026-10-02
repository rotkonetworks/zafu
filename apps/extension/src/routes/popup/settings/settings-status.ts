import { UserChoice } from '@repo/storage-chrome/records';
import type { AllSlices } from '../../../state';
import type { KeyInfo } from '../../../state/keyring';
import type { ZcashWalletJson } from '../../../state/wallets';
import { NETWORKS } from '../../../config/networks';

/** live one-line status for each settings category, from local state only - nothing here asks a server */

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

export const securityStatus = (unbacked: number, autoLock: string) =>
  unbacked > 0
    ? `${plural(unbacked, 'group seat')} not backed up`
    : autoLock === 'off'
      ? 'auto-lock off'
      : `auto-lock ${autoLock}`;

export const selectConnectedSiteCount = (s: AllSlices) =>
  (Array.isArray(s.connectedSites.knownSites) ? s.connectedSites.knownSites : []).filter(
    r => r.choice === UserChoice.Approved,
  ).length;

/** the defaults are the private ones; any leak switched on reads as "your settings" */
export const selectPrivateDefaults = (s: AllSlices) => {
  const p = s.privacy.settings;
  return !(
    p.enableTransparentBalances ||
    p.enableTransactionHistory ||
    p.enableBackgroundSync ||
    p.enablePriceFetching ||
    p.enableExplorerLinks
  );
};

export const privacyStatus = (privateDefaults: boolean, sites: number) =>
  `${privateDefaults ? 'private defaults' : 'your settings'} · ${
    sites ? `${plural(sites, 'site')} connected` : 'no sites connected'
  }`;

export const networksStatus = (enabled: readonly string[]) =>
  enabled.map(n => NETWORKS[n]?.name.toLowerCase() ?? n).join(' · ') || 'no networks on';

export const isZigner = (k: KeyInfo) =>
  k.type === 'zigner-zafu' && (k.insensitive['coldSignerType'] ?? 'zigner') === 'zigner';

export const selectZignerPaired = (s: AllSlices) => s.keyRing.keyInfos.some(isZigner);

export const devicesStatus = (zigner: boolean, theme: string) =>
  `${zigner ? 'zigner paired' : 'no zigner yet'} · ${theme} theme`;
