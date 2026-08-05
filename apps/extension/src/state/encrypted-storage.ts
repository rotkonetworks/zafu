/**
 * encrypted storage  - wraps chrome.storage.local values with password encryption
 *
 * stores data as { encrypted: BoxJson } in place of the plaintext value.
 * requires session key (password) to read or write.
 * falls back to reading plaintext for migration from unencrypted storage.
 */

import { Key } from '@repo/encryption/key';
import { Box, type BoxJson } from '@repo/encryption/box';
import type { ExtensionStorage } from '@repo/storage-chrome/base';
import type { LocalStorageState } from '@repo/storage-chrome/local';
import type { SessionStorageState } from '@repo/storage-chrome/session';

interface EncryptedWrapper {
  encrypted: BoxJson;
}

export const isEncryptedWrapper = (v: unknown): v is EncryptedWrapper =>
  typeof v === 'object' &&
  v !== null &&
  'encrypted' in v &&
  typeof (v as EncryptedWrapper).encrypted === 'object';

async function getKey(session: ExtensionStorage<SessionStorageState>): Promise<Key | null> {
  const keyJson = await session.get('passwordKey');
  if (!keyJson) {
    return null;
  }
  return Key.fromJson(keyJson);
}

/**
 * hydration gate — prevents writeEncrypted from overwriting storage
 * before readEncrypted has loaded the existing data. without this,
 * a persist() call during startup can wipe contacts/wallets with [].
 */
const hydratedKeys = new Set<string>();
let hydratePromise: Promise<void> | null = null;
let hydrateResolve: (() => void) | null = null;

/** mark that encrypted data has been hydrated (called by persist.ts after hydrateEncryptedData) */
export function markHydrated(): void {
  hydratedKeys.add('*');
  if (hydrateResolve) {
    hydrateResolve();
    hydrateResolve = null;
    hydratePromise = null;
  }
}

/** wait until hydration is complete before allowing writes */
function waitForHydration(): Promise<void> {
  if (hydratedKeys.has('*')) {
    return Promise.resolve();
  }
  if (!hydratePromise) {
    hydratePromise = new Promise(r => {
      hydrateResolve = r;
    });
  }
  return hydratePromise;
}

/** read an encrypted value from local storage. returns plaintext data or null. */
export async function readEncrypted<T>(
  local: ExtensionStorage<LocalStorageState>,
  session: ExtensionStorage<SessionStorageState>,
  storageKey: keyof LocalStorageState,
): Promise<T | null> {
  const raw = await local.get(storageKey);
  if (!raw) {
    return null;
  }

  if (!isEncryptedWrapper(raw)) {
    return null;
  } // not encrypted  - ignore stale data

  const key = await getKey(session);
  if (!key) {
    return null;
  } // locked  - can't decrypt
  const plaintext = await key.unseal(Box.fromJson(raw.encrypted));
  if (!plaintext) {
    return null;
  }
  return JSON.parse(plaintext) as T;
}

/** write an encrypted value to local storage. */
export async function writeEncrypted(
  local: ExtensionStorage<LocalStorageState>,
  session: ExtensionStorage<SessionStorageState>,
  storageKey: keyof LocalStorageState,
  data: unknown,
): Promise<void> {
  // wait for hydration to complete before writing — prevents overwriting
  // existing encrypted data with empty/partial in-memory state during startup
  await waitForHydration();

  const key = await getKey(session);
  if (!key) {
    console.warn(`[encrypted-storage] skipping write of '${storageKey}'  - wallet is locked`);
    return;
  }

  const plaintext = JSON.stringify(data);
  const box = await key.seal(plaintext);
  await local.set(storageKey, { encrypted: box.toJson() } as never);
}

/** keys encrypted at rest  - decrypted on-demand via session key.
 *  wallets/zcashWallets contain viewing keys (FVK) that reveal full
 *  transaction history. no viewing key data in plaintext storage  - ever. */
/** knownSites is NOT encrypted  - origin approval records ({ origin, choice, date })
 *  contain no private data and are read by the origin storage package which
 *  doesn't have access to the session key. */
const ENCRYPTED_KEYS = new Set<string>([
  'penumbraWallets',
  'zcashWallets',
  'contacts',
  'recentAddresses',
  'dismissedContactSuggestions',
  'messages',
  'diversifiedAddresses',
]);

/** should this storage key be encrypted? */
export const isEncryptedKey = (key: string): boolean => ENCRYPTED_KEYS.has(key);

/**
 * Read an encrypted key from OUTSIDE the zustand store, migrating a legacy
 * plaintext value in place if one is found.
 *
 * Why this exists: `createEncryptedLocal` is only applied to the store's
 * `local` handle (state/index.ts). UI code that reaches for `localExtStorage`
 * directly bypasses it completely, and writes the value in the clear even
 * though the key is listed in ENCRYPTED_KEYS. That is how
 * `diversifiedAddresses` — the user's payment-referral graph, mapping
 * contact names to the diversified addresses handed to them — came to be
 * stored unencrypted despite being declared encrypted.
 *
 * The migration matters: `readEncrypted` returns null for an unwrapped
 * value, so simply switching the read path over would have made every
 * existing record vanish silently. Instead a plaintext value is detected,
 * re-written sealed, and returned. It cannot be migrated while locked (there
 * is no key), so a locked read returns null and leaves the plaintext alone
 * to be migrated on the next unlocked read.
 */
export async function readEncryptedWithMigration<T>(
  local: ExtensionStorage<LocalStorageState>,
  session: ExtensionStorage<SessionStorageState>,
  storageKey: keyof LocalStorageState,
): Promise<T | null> {
  const raw = await local.get(storageKey);
  if (raw === undefined || raw === null) {
    return null;
  }
  if (isEncryptedWrapper(raw)) {
    return readEncrypted<T>(local, session, storageKey);
  }
  // legacy plaintext — seal it now, if we can.
  const key = await getKey(session);
  if (!key) {
    return null;
  }
  await writeEncrypted(local, session, storageKey, raw);
  console.log(`[encrypted-storage] migrated plaintext '${String(storageKey)}' to encrypted`);
  return raw as T;
}

/** Write an encrypted key from outside the zustand store. */
export async function writeEncryptedDirect(
  local: ExtensionStorage<LocalStorageState>,
  session: ExtensionStorage<SessionStorageState>,
  storageKey: keyof LocalStorageState,
  data: unknown,
): Promise<void> {
  await writeEncrypted(local, session, storageKey, data);
}

/**
 * encrypted local storage proxy  - wraps ExtensionStorage to auto-encrypt/decrypt
 * specific keys. all other keys pass through unchanged.
 */
export function createEncryptedLocal(
  local: ExtensionStorage<LocalStorageState>,
  session: ExtensionStorage<SessionStorageState>,
): ExtensionStorage<LocalStorageState> {
  return {
    get: async <K extends keyof LocalStorageState>(key: K) => {
      if (isEncryptedKey(key as string)) {
        const result = await readEncrypted<LocalStorageState[K]>(local, session, key);
        return result!;
      }
      return local.get(key);
    },
    set: async <K extends keyof LocalStorageState>(key: K, value: LocalStorageState[K]) => {
      if (isEncryptedKey(key as string)) {
        await writeEncrypted(local, session, key, value);
        return;
      }
      await local.set(key, value);
    },
    remove: key => local.remove(key),
    addListener: listener => local.addListener(listener),
    removeListener: listener => local.removeListener(listener),
  } as ExtensionStorage<LocalStorageState>;
}
