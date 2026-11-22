/**
 * Personal data = the local-only, chain-irreplaceable data the wallet holds:
 *   - send history ('sent' store: recipient, amount, fee, memo the chain can
 *     never give back, because an outgoing note is encrypted to the recipient;
 *     recipient and memo sealed, see ./sent-seal),
 *   - per-tx "from" notes (chrome.storage 'txNotes', sealed),
 *   - contacts (their own slice).
 *
 * It is deliberately separate from the SYNC CACHE (notes/witnesses/meta), which
 * a resync rebuilds from the chain. This module clears the first two; contacts
 * are cleared by the caller via the contacts slice (it owns its own storage).
 */

import { localExtStorage, type LocalStorageState } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import type { SentTxRecord } from '../workers/sent-tx-reconcile';
import { readEncryptedWithMigration, writeEncryptedDirect } from './encrypted-storage';
import { openSent, openZcashDb, sealSentRecords, sentKey } from './sent-seal';

export const TX_NOTES_KEY = 'txNotes';
const NOTES = TX_NOTES_KEY as keyof LocalStorageState;

/** one request on the 'sent' store, answered with `fallback` when anything fails */
const onSent = async <T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest | void,
  fallback: T,
): Promise<T> => {
  const db = await openZcashDb();
  if (!db) {
    return fallback;
  }
  try {
    const tx = db.transaction('sent', mode);
    const req = run(tx.objectStore('sent'));
    return await new Promise<T>(resolve => {
      tx.oncomplete = () => resolve(req ? (req.result as T) : fallback);
      tx.onerror = () => resolve(fallback);
      tx.onabort = () => resolve(fallback);
    });
  } catch {
    return fallback;
  } finally {
    db.close();
  }
};

/** All local send records across wallets, opened (for backup/export). */
export const readSentRecords = async (): Promise<SentTxRecord[]> => {
  const records = (await onSent<SentTxRecord[] | undefined>('readonly', s => s.getAll(), [])) ?? [];
  const key = records.some(r => r.sealed) ? await sentKey(false) : null;
  // one that does not open still carries its txid, amount and fee
  return Promise.all(
    records.map(async r => {
      const { sealed: _, ...rest } = await openSent(r, key);
      return rest;
    }),
  );
};

/** Restore send records (import), sealed once written. Each carries its own [walletId, txid] key. */
export const writeSentRecords = async (records: readonly SentTxRecord[]): Promise<void> => {
  if (records.length === 0) {
    return;
  }
  await onSent('readwrite', s => records.forEach(r => s.put(r)), undefined);
  await sealSentRecords();
};

/** Clear the local send history ('sent' object store), keeping the DB + cache. */
const clearSentStore = () => onSent('readwrite', s => void s.clear(), undefined);

export interface ClearPersonalDataOptions {
  /** wipe per-tx "from" notes */
  notes: boolean;
  /** wipe local send history */
  sent: boolean;
  /** wipe the passwords tool's saved logins (never passwords, only what fills the
   *  form) and which wallet made which passkey */
  logins: boolean;
  /** wipe your own addresses on other chains */
  addresses: boolean;
}

/**
 * Clear the parts of personal data `opts` names, and only those. Contacts are cleared
 * separately by the caller (contactsSlice.clearAll) since they live in their
 * own store. This never touches the sync cache.
 */
export const clearPersonalData = async (opts: ClearPersonalDataOptions): Promise<void> => {
  if (opts.notes) {
    await chrome.storage.local.remove(TX_NOTES_KEY);
  }
  if (opts.sent) {
    await clearSentStore();
  }
  if (opts.logins) {
    await chrome.storage.local.remove(['passwordLogins', 'passkeyGrants']);
  }
  if (opts.addresses) {
    await chrome.storage.local.remove('yourAddresses');
  }
};

/**
 * All per-tx notes, sealed at rest; a legacy plaintext map is sealed on the
 * way. Throws while locked, so a merge can never write back an empty map.
 */
export const readTxNotes = async (): Promise<Record<string, string>> =>
  (await readEncryptedWithMigration<Record<string, string>>(
    localExtStorage,
    sessionExtStorage,
    NOTES,
  )) ?? {};

/** Write per-tx notes, merging over existing by default; false while locked. */
export const writeTxNotes = async (
  notes: Record<string, string>,
  mode: 'merge' | 'replace' = 'merge',
): Promise<boolean> => {
  const existing = mode === 'merge' ? await readTxNotes() : {};
  return writeEncryptedDirect(localExtStorage, sessionExtStorage, NOTES, {
    ...existing,
    ...notes,
  });
};
