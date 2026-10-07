import { UserChoice } from '@repo/storage-chrome/records';
import type { AllSlices } from '../../../state';
import type { KeyInfo } from '../../../state/keyring';
import type { ZcashWalletJson } from '../../../state/wallets';
import { hasFeature, NETWORKS } from '../../../config/networks';
import { selectZcashBackend } from '../../../state/networks';
import { ZCASH_BACKENDS } from '../../../state/keyring/zcash-backend';

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

/**
 * the privacy settings switched to let more be seen, each counted only where
 * its network is on. zcash.me's live mode lives outside the store and is
 * added by the caller. contact discovery on is the chosen default, so it
 * does not count.
 */
export const selectOpenings = (s: AllSlices): number => {
  const p = s.privacy.settings;
  const on = (f: 'zcash' | 'cosmos') => s.keyRing.enabledNetworks.some(n => hasFeature(n, f));
  const zcash = s.networks.networks.zcash;
  // memo decoys and instant pending exist only on a zidecar node
  const wire = on('zcash') && !!ZCASH_BACKENDS[selectZcashBackend(s)].extras;
  return [
    p.enableTransactionHistory,
    p.enableExplorerLinks,
    on('cosmos') && p.enableTransparentBalances,
    on('zcash') && p.zcashTransparentEachBlock,
    wire && zcash.memoSyncStrategy === 'fast',
    wire && zcash.mempoolWatch === 'on',
  ].filter(Boolean).length;
};

export const privacyStatus = (openings: number, sites: number) =>
  `${openings ? `${plural(openings, 'setting')} less private` : 'private defaults'} · ${
    sites ? `${plural(sites, 'site')} connected` : 'no sites connected'
  }`;

export const networksStatus = (enabled: readonly string[]) =>
  enabled.map(n => NETWORKS[n]?.name.toLowerCase() ?? n).join(' · ') || 'no networks on';

export const isZigner = (k: KeyInfo) =>
  k.type === 'zigner-zafu' && (k.insensitive['coldSignerType'] ?? 'zigner') === 'zigner';

export const selectZignerPaired = (s: AllSlices) => s.keyRing.keyInfos.some(isZigner);

export const devicesStatus = (zigner: boolean, theme: string) =>
  `${zigner ? 'zigner paired' : 'no zigner yet'} · ${theme} theme`;
