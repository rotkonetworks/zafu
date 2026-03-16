/**
 * encrypted storage — wraps chrome.storage.local values with password encryption
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

const isEncryptedWrapper = (v: unknown): v is EncryptedWrapper =>
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

  // check if already encrypted
  if (isEncryptedWrapper(raw)) {
    const key = await getKey(session);
    if (!key) return null; // locked — can't decrypt
    const plaintext = await key.unseal(Box.fromJson(raw.encrypted));
    if (!plaintext) return null;
    return JSON.parse(plaintext) as T;
  }

  // plaintext (legacy) — return as-is for migration
  return raw as T;
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
    // no session key (locked or no password set) — store plaintext
    // this handles the airgap-only setup case
    await local.set(storageKey, data as never);
    return;
  }

  const plaintext = JSON.stringify(data);
  const box = await key.seal(plaintext);
  await local.set(storageKey, { encrypted: box.toJson() } as never);
}
