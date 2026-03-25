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
  typeof v === 'object' && v !== null && 'encrypted' in v &&
  typeof (v as EncryptedWrapper).encrypted === 'object';

async function getKey(session: ExtensionStorage<SessionStorageState>): Promise<Key | null> {
  const keyJson = await session.get('passwordKey');
  if (!keyJson) return null;
  return Key.fromJson(keyJson);
}

/** read an encrypted value from local storage. returns plaintext data or null. */
export async function readEncrypted<T>(
  local: ExtensionStorage<LocalStorageState>,
  session: ExtensionStorage<SessionStorageState>,
  storageKey: keyof LocalStorageState,
): Promise<T | null> {
  const raw = await local.get(storageKey);
  if (!raw) return null;

  if (!isEncryptedWrapper(raw)) return null; // not encrypted  - ignore stale data

  const key = await getKey(session);
  if (!key) return null; // locked  - can't decrypt
  const plaintext = await key.unseal(Box.fromJson(raw.encrypted));
  if (!plaintext) return null;
  return JSON.parse(plaintext) as T;
}

/** write an encrypted value to local storage. */
export async function writeEncrypted(
  local: ExtensionStorage<LocalStorageState>,
  session: ExtensionStorage<SessionStorageState>,
  storageKey: keyof LocalStorageState,
  data: unknown,
): Promise<void> {
  const key = await getKey(session);
  if (!key) {
    // locked  - skip write silently. callers must ensure they only write
    // when unlocked, or accept that the write will be deferred.
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
]);

/** should this storage key be encrypted? */
export const isEncryptedKey = (key: string): boolean => ENCRYPTED_KEYS.has(key);

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
        return result as LocalStorageState[K];
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
    remove: (key) => local.remove(key),
    addListener: (listener) => local.addListener(listener),
    removeListener: (listener) => local.removeListener(listener),
  } as ExtensionStorage<LocalStorageState>;
}
