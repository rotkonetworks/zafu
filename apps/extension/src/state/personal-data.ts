/**
 * Personal data = the local-only, chain-irreplaceable data the wallet holds:
 *   - send history ('sent' store: recipient, amount, fee, memo the chain can
 *     never give back, because an outgoing note is encrypted to the recipient),
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

const ZCASH_DB = 'zafu-zcash';
export const TX_NOTES_KEY = 'txNotes';
const NOTES = TX_NOTES_KEY as keyof LocalStorageState;

const openZcashDb = (): Promise<IDBDatabase | null> =>
  new Promise(resolve => {
    try {
      const req = indexedDB.open(ZCASH_DB);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

/** All local send records across wallets (for backup/export). */
export const readSentRecords = async (): Promise<SentTxRecord[]> => {
  const db = await openZcashDb();
  if (!db || !db.objectStoreNames.contains('sent')) {
    db?.close();
    return [];
  }
  return new Promise(resolve => {
    try {
      const req = db.transaction('sent', 'readonly').objectStore('sent').getAll();
      req.onsuccess = () => {
        db.close();
        resolve((req.result as SentTxRecord[] | undefined) ?? []);
      };
      req.onerror = () => {
        db.close();
        resolve([]);
      };
    } catch {
      db.close();
      resolve([]);
    }
  });
};

/** Restore send records (import). Each carries its own [walletId, txid] key. */
export const writeSentRecords = async (records: readonly SentTxRecord[]): Promise<void> => {
  if (records.length === 0) {
    return;
  }
  const db = await openZcashDb();
  if (!db || !db.objectStoreNames.contains('sent')) {
    db?.close();
    return;
  }
  return new Promise(resolve => {
    try {
      const tx = db.transaction('sent', 'readwrite');
      const store = tx.objectStore('sent');
      for (const r of records) {
        store.put(r);
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
};

/** Clear the local send history ('sent' object store), keeping the DB + cache. */
const clearSentStore = (): Promise<void> =>
  new Promise(resolve => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(ZCASH_DB);
    } catch {
      resolve();
      return;
    }
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sent')) {
        db.close();
        resolve();
        return;
      }
      try {
        const tx = db.transaction('sent', 'readwrite');
        tx.objectStore('sent').clear();
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          resolve();
        };
      } catch {
        db.close();
        resolve();
      }
    };
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });

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
