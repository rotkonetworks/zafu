import { ExtensionStorage, ExtensionStorageDefaults } from './base';
import { localMigrations } from './migrations';
import { VERSION as LocalStorageVersion, LOCAL as LocalStorageState } from './versions/v3';

const localDefaults: ExtensionStorageDefaults<LocalStorageState> = {
  penumbraWallets: [],
  knownSites: [],
  numeraires: [],
};

// Migrations MUST be attached here (at construction) rather than only in the
// service-worker realm. The popup and options-page bundles import their own
// localExtStorage instance in a separate JS realm; if migrations were enabled
// only in the SW, a pre-v3 -> v3 upgrade would throw "Failed to migrate
// storage" in whichever realm won the storage lock first (the loaders run
// before the ephemeral MV3 worker is guaranteed to). Migration runs under a
// shared navigator.locks exclusive lock, so enabling it in every realm is safe
// - the realm that loses the lock just sees version 3 and no-ops.
export const localExtStorage = new ExtensionStorage<LocalStorageState, LocalStorageVersion>(
  chrome.storage.local,
  localDefaults,
  3,
  localMigrations,
);

export type { LocalStorageState, LocalStorageVersion };
export type LocalStorage = ExtensionStorage<LocalStorageState, LocalStorageVersion>;
