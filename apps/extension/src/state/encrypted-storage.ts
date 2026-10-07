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
import { keyUse } from './keyring-lock';
import { resealSnapshot } from './keyring/reseal';

interface EncryptedWrapper {
  encrypted: BoxJson;
}

/**
 * true only when `v` is a genuine `{ encrypted: BoxJson }` wrapper - the inner
 * box must actually have its `nonce`/`cipherText` strings, not just be *an
 * object*. A shape that merely looks sealed (e.g. an interrupted write, or a
 * value another realm wrote mid-migration) must never reach `Box.fromJson`:
 * its base64 decode asserts `nonce`/`cipherText` are present strings and
 * throws (uncaught, since callers fire-and-forget `hydrateEncryptedData()`)
 * when they are not. Treating a malformed wrapper as "not encrypted" instead
 * routes it through the same "absent - ignore stale data" path already used
 * for genuinely missing values.
 */
export const isEncryptedWrapper = (v: unknown): v is EncryptedWrapper => {
  if (typeof v !== 'object' || v === null || !('encrypted' in v)) {
    return false;
  }
  const encrypted = (v as EncryptedWrapper).encrypted;
  return (
    typeof encrypted === 'object' &&
    encrypted !== null &&
    typeof (encrypted as Partial<BoxJson>).nonce === 'string' &&
    typeof (encrypted as Partial<BoxJson>).cipherText === 'string'
  );
};

/** the session's password key, or null while locked */
export async function getKey(session: ExtensionStorage<SessionStorageState>): Promise<Key | null> {
  const keyJson = await session.get('passwordKey');
  if (!keyJson) {
    return null;
  }
  return Key.fromJson(keyJson);
}

/**
 * hydration gate - prevents writeEncrypted from overwriting storage
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

/**
 * Resolves once this realm read its encrypted data. A write made from state
 * read before then would overwrite what storage holds (the gate below delays
 * the write, but its data was taken already): screens that write on their
 * own, not on a tap, wait for this first.
 */
export const whenHydrated = (): Promise<void> => waitForHydration();

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

/**
 * A context that held wallet records from before a password change writes
 * them back with inner boxes (a penumbra seed, a FROST share) the old key
 * sealed. While the change's retired key lasts, move those to the current key
 * so the outer box and what it holds always open together.
 */
async function moveRetiredBoxes(
  session: ExtensionStorage<SessionStorageState>,
  data: unknown,
  key: Key,
): Promise<unknown> {
  const retired = await session.get('retiredPasswordKey');
  if (!retired || retired.until < Date.now()) {
    return data;
  }
  const { v } = await resealSnapshot({ v: data }, await Key.fromJson(retired.key), key);
  return v === undefined ? data : v;
}

/** read an encrypted value from local storage. returns plaintext data or null. */
export async function readEncrypted<T>(
  local: ExtensionStorage<LocalStorageState>,
  session: ExtensionStorage<SessionStorageState>,
  storageKey: keyof LocalStorageState,
): Promise<T | null> {
  return keyUse(async () => {
    const raw = await local.get(storageKey);
    if (!raw || !isEncryptedWrapper(raw)) {
      return null; // absent, or not encrypted - ignore stale data
    }
    const key = await getKey(session);
    if (!key) {
      return null; // locked - can't decrypt
    }
    const plaintext = await key.unseal(Box.fromJson(raw.encrypted));
    return plaintext ? (JSON.parse(plaintext) as T) : null;
  });
}

/**
 * write an encrypted value to local storage.
 *
 * Returns whether it was persisted. `false` means the wallet is locked, so
 * there is no session key to seal with and the write was SKIPPED - a caller that
 * is handing out what it just wrote (a generated secret, say) must not treat
 * that value as durable.
 */
export async function writeEncrypted(
  local: ExtensionStorage<LocalStorageState>,
  session: ExtensionStorage<SessionStorageState>,
  storageKey: keyof LocalStorageState,
  data: unknown,
): Promise<boolean> {
  // wait for hydration to complete before writing - prevents overwriting
  // existing encrypted data with empty/partial in-memory state during startup
  await waitForHydration();

  return keyUse(async () => {
    const key = await getKey(session);
    if (!key) {
      console.warn(`[encrypted-storage] skipping write of '${storageKey}'  - wallet is locked`);
      return false;
    }
    const box = await key.seal(JSON.stringify(await moveRetiredBoxes(session, data, key)));
    await local.set(storageKey, { encrypted: box.toJson() } as never);
    return true;
  });
}

/** keys encrypted at rest  - decrypted on-demand via session key.
 *  wallets/zcashWallets contain viewing keys (FVK) that reveal full
 *  transaction history. no viewing key data in plaintext storage  - ever.
 *  frostRelayIdentities holds each group's x25519 relay key, which also
 *  seals group-chat frames  - a confidentiality secret, so sealed too. */
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
  // the retired frostd group chat's history: still sealed, read by nothing
  'groupChats',
  'frostRelayIdentities',
  'passwordLogins',
  'passkeyGrants',
  'yourAddresses',
  'peopleRooms',
  'peopleThreads',
  'peopleInvites',
  // an open buy: the seller's handle, the base address, the 1click deposit
  'openBuy',
  // swaps in flight: deposit addresses, memos, the swap's own t-address
  'openSwaps',
  // zec liquidity: each pocket's lp address index, its last read, an add or take-out in flight
  'zecLp',
  // what zafu contacted lately: destinations and when, kept on this computer only
  'netContacted',
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
 * `diversifiedAddresses` - the user's payment-referral graph, mapping
 * contact names to the diversified addresses handed to them - came to be
 * stored unencrypted despite being declared encrypted.
 *
 * The migration matters: `readEncrypted` returns null for an unwrapped
 * value, so simply switching the read path over would have made every
 * existing record vanish silently. Instead a plaintext value is detected,
 * re-written sealed, and returned.
 *
 * Its callers read, change and write back the whole value, so a locked
 * wallet throws rather than answering empty - that is how a
 * read-modify-write wipes a list. A box that does not open with the current
 * key (orphaned by an older password change) is moved aside to
 * `<key>.unopened`, kept, and read as absent.
 */
export class SealedReadError extends Error {
  constructor(storageKey: string) {
    super(`'${storageKey}' could not be read: wallet is locked`);
    this.name = 'SealedReadError';
  }
}

export async function readEncryptedWithMigration<T>(
  local: ExtensionStorage<LocalStorageState>,
  session: ExtensionStorage<SessionStorageState>,
  storageKey: keyof LocalStorageState,
): Promise<T | null> {
  return keyUse(async () => {
    const raw = await local.get(storageKey);
    if (raw === undefined || raw === null) {
      return null;
    }
    const key = await getKey(session);
    if (!key) {
      throw new SealedReadError(String(storageKey));
    }
    const looksSealed = typeof raw === 'object' && raw !== null && 'encrypted' in raw;
    if (looksSealed && !isEncryptedWrapper(raw)) {
      // shaped like a sealed wrapper (has an `encrypted` property) but the
      // inner box is malformed/corrupt - never attempt to decrypt it (that
      // throws), and never fall through to the "legacy plaintext" branch
      // below, which would reseal the garbage itself as the new value
      await chrome.storage.local.set({ [`${String(storageKey)}.unopened`]: raw });
      await local.remove(storageKey);
      console.warn(`[encrypted-storage] '${String(storageKey)}' is malformed; kept aside`);
      return null;
    }
    if (isEncryptedWrapper(raw)) {
      const plaintext = await key.unseal(Box.fromJson(raw.encrypted));
      if (plaintext === null) {
        // orphaned by an older password change: keep it aside, untouched, and
        // let the feature start fresh rather than stay broken for good
        await chrome.storage.local.set({ [`${String(storageKey)}.unopened`]: raw });
        await local.remove(storageKey);
        console.warn(`[encrypted-storage] '${String(storageKey)}' does not open; kept aside`);
        return null;
      }
      return JSON.parse(plaintext) as T;
    }
    // legacy plaintext - seal it now
    await writeEncrypted(local, session, storageKey, raw);
    console.log(`[encrypted-storage] migrated plaintext '${String(storageKey)}' to encrypted`);
    return raw as T;
  });
}

/** Write an encrypted key from outside the zustand store. Returns whether it landed. */
export async function writeEncryptedDirect(
  local: ExtensionStorage<LocalStorageState>,
  session: ExtensionStorage<SessionStorageState>,
  storageKey: keyof LocalStorageState,
  data: unknown,
): Promise<boolean> {
  return writeEncrypted(local, session, storageKey, data);
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
