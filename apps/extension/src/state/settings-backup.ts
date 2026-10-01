/**
 * The user's settings inside the encrypted personal-data backup: the privacy
 * slice plus the preferences kept as their own storage keys. A restore is the
 * user choosing again, so present values replace current ones; absent ones
 * (older backups) leave the current value alone.
 */

import { localExtStorage } from '@repo/storage-chrome/local';
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
  'penumbraTotalIn',
  'penumbraRowsInUsd',
  'swapRoutes',
] as const;

type PrefKey = (typeof PREF_KEYS)[number];

export interface SettingsBackup {
  privacy?: Partial<PrivacySettings>;
  prefs?: Partial<Record<PrefKey, unknown>>;
}

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
  return { privacy: withoutProxy(privacy), prefs };
};

/** the privacy settings after restoring `incoming` over `current`, keys limited to known ones */
export const restoredPrivacy = (
  current: PrivacySettings,
  incoming: Partial<PrivacySettings> | undefined,
): PrivacySettings => {
  const next = { ...current };
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
