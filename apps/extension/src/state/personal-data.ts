/**
 * Personal data = the local-only, chain-irreplaceable data the wallet holds:
 *   - send history ('sent' store: recipient, amount, fee, memo the chain can
 *     never give back, because an outgoing note is encrypted to the recipient),
 *   - per-tx "from" notes (chrome.storage 'txNotes'),
 *   - contacts (their own slice).
 *
 * It is deliberately separate from the SYNC CACHE (notes/witnesses/meta), which
 * a resync rebuilds from the chain. This module clears the first two; contacts
 * are cleared by the caller via the contacts slice (it owns its own storage).
 */

const ZCASH_DB = 'zafu-zcash';
const TX_NOTES_KEY = 'txNotes';

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
}

/**
 * Clear the notes + send-history parts of personal data. Contacts are cleared
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
};

/** Read all per-tx notes (for backup/export). */
export const readTxNotes = async (): Promise<Record<string, string>> => {
  const r = await chrome.storage.local.get(TX_NOTES_KEY);
  return (r[TX_NOTES_KEY] as Record<string, string> | undefined) ?? {};
};

/** Write per-tx notes (for import/restore); merges over existing by default. */
export const writeTxNotes = async (
  notes: Record<string, string>,
  mode: 'merge' | 'replace' = 'merge',
): Promise<void> => {
  const existing = mode === 'merge' ? await readTxNotes() : {};
  await chrome.storage.local.set({ [TX_NOTES_KEY]: { ...existing, ...notes } });
};
