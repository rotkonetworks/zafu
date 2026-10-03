/**
 * The user's settings inside the encrypted personal-data backup: the privacy
 * slice plus the preferences kept as their own storage keys. A restore is the
 * user choosing again, so present values replace current ones; absent ones
 * (older backups) leave the current value alone.
 */

import { localExtStorage } from '@repo/storage-chrome/local';
import { COSMOS_CHAINS } from '@repo/wallet/networks/cosmos/chains';
import { rpcPoolKey } from '../net/egress-policy';
import { DEFAULT_PRIVACY_SETTINGS, type PrivacySettings } from './privacy';

/** settings that live as plain storage keys rather than in a slice */
const PREF_KEYS = [
  'autoLockMinutes',
  'zafuTheme',
  'zafuFont',
  'approvalSurface',
  'approvalsInSidePanel',
  'zidDiscovery',
  'networkEndpoints',
  'zcashBackend',
  'hiddenTransparentChains',
  'transparentAgreed',
  'penumbraTotalIn',
  'penumbraRowsInUsd',
  'swapRoutes',
] as const;

type PrefKey = (typeof PREF_KEYS)[number];

export interface SettingsBackup {
  privacy?: Partial<PrivacySettings>;
  prefs?: Partial<Record<PrefKey, unknown>>;
  /** each transparent chain's node list the user picked, by chain id */
  nodePools?: Record<string, string[]>;
}

const poolKeys = () => Object.keys(COSMOS_CHAINS).map(c => [c, rpcPoolKey(c)] as const);

/** proxy is shelved and is applied to chrome.proxy only through setProxy, so it never rides along */
const withoutProxy = ({ proxy: _proxy, ...rest }: Partial<PrivacySettings>) => rest;

export const exportSettings = async (privacy: PrivacySettings): Promise<SettingsBackup> => {
  const prefs: Partial<Record<PrefKey, unknown>> = {};
  for (const k of PREF_KEYS) {
    const v = await localExtStorage.get(k);
    if (v !== undefined) {
      prefs[k] = v;
    }
  }
  const stored = await chrome.storage.local.get(poolKeys().map(([, k]) => k));
  const nodePools: Record<string, string[]> = {};
  for (const [c, k] of poolKeys()) {
    if (Array.isArray(stored[k]) && stored[k].length) {
      nodePools[c] = stored[k] as string[];
    }
  }
  return { privacy: withoutProxy(privacy), prefs, nodePools };
};

/** the privacy settings after restoring `incoming` over `current`, keys limited to known ones */
export const restoredPrivacy = (
  current: PrivacySettings,
  incoming: Partial<PrivacySettings> | undefined,
): PrivacySettings => {
  const next = { ...current };
  // a backup from before storage v5 names penumbra's "keep syncing when
  // closed" by its old, shared name
  const legacy = (incoming as { enableBackgroundSync?: unknown } | undefined)?.enableBackgroundSync;
  if (typeof legacy === 'boolean' && incoming?.keepPenumbraSyncing === undefined) {
    next.keepPenumbraSyncing = legacy;
  }
  for (const [k, v] of Object.entries(withoutProxy(incoming ?? {}))) {
    const key = k as keyof PrivacySettings;
    if (key in DEFAULT_PRIVACY_SETTINGS && typeof v === typeof DEFAULT_PRIVACY_SETTINGS[key]) {
      (next as Record<string, unknown>)[key] = v;
    }
  }
  return next;
};

export const importPrefs = async (prefs: SettingsBackup['prefs']): Promise<void> => {
  for (const k of PREF_KEYS) {
    if (prefs?.[k] !== undefined) {
      await localExtStorage.set(k, prefs[k] as never);
    }
  }
};

/** put back each chain's node list; a chain the backup does not name keeps its own */
export const importNodePools = async (pools: SettingsBackup['nodePools']): Promise<void> => {
  for (const [c, k] of poolKeys()) {
    const list = pools?.[c];
    if (Array.isArray(list) && list.every(u => typeof u === 'string' && /^https?:\/\//.test(u))) {
      await chrome.storage.local.set({ [k]: list });
    }
  }
};
