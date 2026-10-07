/**
 * The user's settings inside the encrypted personal-data backup: the privacy
 * slice plus the preferences kept as their own storage keys. A restore is the
 * user choosing again, so present values replace current ones; absent ones
 * (older backups) leave the current value alone.
 */

import { localExtStorage } from '@repo/storage-chrome/local';
import { COSMOS_CHAINS } from '@repo/wallet/networks/cosmos/chains';
import { rpcPoolKey } from '../net/egress-policy';
import { NETWORKS } from '../config/networks';
import { DEFAULT_PRIVACY_SETTINGS, type PrivacySettings } from './privacy';

type Parse = (v: unknown) => unknown;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf =
  (...ok: unknown[]): Parse =>
  v =>
    ok.includes(v) ? v : undefined;
const bool: Parse = v => (typeof v === 'boolean' ? v : undefined);
const num: Parse = v => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const strs: Parse = v => (Array.isArray(v) && v.every(x => typeof x === 'string') ? v : undefined);
const obj: Parse = v => (isObj(v) ? v : undefined);
/** an object whose every value passes `each` */
const recordOf =
  (each: Parse): Parse =>
  v =>
    isObj(v) && Object.values(v).every(x => each(x) !== undefined) ? v : undefined;
const str: Parse = v => (typeof v === 'string' ? v : undefined);

/**
 * settings that live as plain storage keys rather than in a slice, each with
 * the check a restored value must pass; a value that fails is left out
 */
const PREFS = {
  autoLockMinutes: num,
  zafuTheme: oneOf('sumi', 'washi', 'terminal'),
  zafuFont: oneOf('iosevka', 'system'),
  approvalSurface: oneOf('hybrid', 'sidebar', 'popup'),
  approvalsInSidePanel: bool,
  zidDiscovery: obj,
  peopleRelay: obj,
  networkEndpoints: recordOf(str),
  transparentAgreed: strs,
  penumbraTotalIn: oneOf('usd', 'um'),
  penumbraRowsInUsd: strs,
  swapRoutes: recordOf(str),
  swapCustodyAck: strs,
  memoSyncStrategies: recordOf(oneOf('private', 'fast', 'paranoid')),
  mempoolWatchSettings: recordOf(oneOf('off', 'on')),
  // holds the user's own zcash.me api key: theirs, and the backup is sealed
  // (fields after mode may be absent in a config stored by an older version)
  zcashMeConfig: v =>
    isObj(v) &&
    oneOf('off', 'directory', 'live')(v['mode']) !== undefined &&
    [v['mirrorUrl'], v['apiKey']].every(x => x === undefined || typeof x === 'string') &&
    (v['promptDismissed'] === undefined || typeof v['promptDismissed'] === 'boolean') &&
    (v['decoys'] === undefined || num(v['decoys']) !== undefined)
      ? v
      : undefined,
  capabilityModes: recordOf(oneOf('enabled', 'disabled')),
  // an older backup may name a network zafu no longer has; one naming only
  // those would turn every network off, so it is left out
  enabledNetworks: v => {
    const known = (strs(v) as string[] | undefined)?.filter(n => Object.hasOwn(NETWORKS, n));
    return known?.length ? known : undefined;
  },
  keplrCompat: bool,
} satisfies Record<string, Parse>;

type PrefKey = keyof typeof PREFS;
const PREF_KEYS = Object.keys(PREFS) as PrefKey[];

export interface SettingsBackup {
  privacy?: Partial<PrivacySettings>;
  prefs?: Partial<Record<PrefKey, unknown>>;
  /** each transparent chain's node list the user picked, by chain id */
  nodePools?: Record<string, string[]>;
  /** each wallet's zcash sync start height, by owner key (see pocketOwner) */
  birthdays?: Record<string, number>;
}

/** a wallet as the backup names it: its vault id here, its owner key everywhere */
export interface BackupWallet {
  id: string;
  owner: string;
}

const birthdayKey = (vaultId: string) => `zcashBirthday_${vaultId}`;

const poolKeys = () => Object.keys(COSMOS_CHAINS).map(c => [c, rpcPoolKey(c)] as const);

export const exportSettings = async (
  privacy: PrivacySettings,
  wallets: readonly BackupWallet[] = [],
): Promise<SettingsBackup> => {
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
  const heights = await chrome.storage.local.get(wallets.map(w => birthdayKey(w.id)));
  const birthdays: Record<string, number> = {};
  for (const w of wallets) {
    const h = heights[birthdayKey(w.id)];
    if (typeof h === 'number') {
      birthdays[w.owner] = h;
    }
  }
  // only known keys of the right type ride along, so nothing stale or retired is carried
  return {
    privacy: restoredPrivacy(DEFAULT_PRIVACY_SETTINGS, privacy),
    prefs,
    nodePools,
    birthdays,
  };
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
  for (const [k, v] of Object.entries(incoming ?? {})) {
    const key = k as keyof PrivacySettings;
    if (key in DEFAULT_PRIVACY_SETTINGS && typeof v === typeof DEFAULT_PRIVACY_SETTINGS[key]) {
      (next as Record<string, unknown>)[key] = v;
    }
  }
  return next;
};

export const importPrefs = async (prefs: SettingsBackup['prefs']): Promise<void> => {
  for (const k of PREF_KEYS) {
    const v = PREFS[k](prefs?.[k]);
    if (v !== undefined) {
      await localExtStorage.set(k, v as never);
    }
  }
};

/** put back each wallet's sync start; a wallet the backup does not name, or one not here, is skipped */
export const importBirthdays = async (
  birthdays: SettingsBackup['birthdays'],
  wallets: readonly BackupWallet[],
): Promise<void> => {
  for (const w of wallets) {
    const h = birthdays?.[w.owner];
    if (typeof h === 'number' && Number.isSafeInteger(h) && h > 0) {
      await chrome.storage.local.set({ [birthdayKey(w.id)]: h });
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
