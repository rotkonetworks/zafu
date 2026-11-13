/**
 * The zcash worker's `sent` records, sealed at rest.
 *
 * The worker writes a record the moment it broadcasts, unlocked or not, and
 * never holds a key: the extension seals each record's recipient, memo and
 * payments once it is unlocked, and opens them on the history rows the
 * worker hands back. Amount, fee and txid stay plain: the worker needs them
 * for the balance while locked, and the plain note store beside them already
 * tells them.
 *
 * They are sealed under a key of their own, itself sealed under the password
 * (`sentKey`), so a password change moves that one key and never the records.
 */

import { Box } from '@repo/encryption/box';
import { Key, type KeyJson } from '@repo/encryption/key';
import { localExtStorage, type LocalStorageState } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import type { SentPayment, SentTxRecord } from '../workers/sent-tx-reconcile';
import { getKey, isEncryptedWrapper } from './encrypted-storage';
import { keyUse } from './keyring-lock';

const KEY = 'sentKey' as keyof LocalStorageState;

interface Private {
  recipient?: string;
  memo?: string;
  payments?: SentPayment[];
}

/** whether a record or row still carries what sealing takes out */
export const isPlain = (r: Private): boolean =>
  r.recipient !== undefined || r.memo !== undefined || r.payments !== undefined;

/**
 * The records' key; null while locked, or when there is none and `create` is
 * false. One realm makes it at a time, and a stored key that does not open is
 * never replaced: what it sealed would be lost with it. Sealed here rather
 * than through writeEncrypted, whose hydration wait would hold the lock.
 */
export const sentKey = async (create: boolean): Promise<Key | null> =>
  await navigator.locks.request(`${chrome.runtime.id}.sentKey`, { mode: 'exclusive' }, () =>
    keyUse(async () => {
      const password = await getKey(sessionExtStorage);
      if (!password) {
        return null;
      }
      const raw = await localExtStorage.get(KEY);
      if (raw !== undefined) {
        const plain = isEncryptedWrapper(raw)
          ? await password.unseal(Box.fromJson(raw.encrypted))
          : null;
        return plain ? Key.fromJson(JSON.parse(plain) as KeyJson) : null;
      }
      if (!create) {
        return null;
      }
      const fresh = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
        'encrypt',
        'decrypt',
      ]);
      const json: KeyJson = { _inner: await crypto.subtle.exportKey('jwk', fresh) };
      const box = (await password.seal(JSON.stringify(json))).toJson();
      await localExtStorage.set(KEY, { encrypted: box } as never);
      return Key.fromJson(json);
    }),
  );

/** the record with its recipient, memo and payments sealed */
export const sealSent = async (rec: SentTxRecord, key: Key): Promise<SentTxRecord> => {
  const { recipient, memo, payments, ...rest } = rec;
  const box = await key.seal(JSON.stringify({ recipient, memo, payments }));
  return { ...rest, sealed: box.toJson() };
};

/** the record or row with what was sealed back in place; unchanged when it does not open */
export const openSent = async <T extends Private & { sealed?: SentTxRecord['sealed'] }>(
  row: T,
  key: Key | null,
): Promise<T> => {
  if (!row.sealed || !key) {
    return row;
  }
  const plain = await key.unseal(Box.fromJson(row.sealed));
  if (!plain) {
    return row;
  }
  const { sealed: _, ...rest } = row;
  return { ...rest, ...(JSON.parse(plain) as Private) } as T;
};

/** history rows from the worker, opened; a plain record among them gets sealed */
export const openSentRows = async <
  T extends Private & { kind?: string; sealed?: SentTxRecord['sealed'] },
>(
  rows: T[],
): Promise<T[]> => {
  if (rows.some(r => r.kind && !r.sealed && isPlain(r))) {
    void sealSentRecords();
  }
  if (!rows.some(r => r.sealed)) {
    return rows;
  }
  const key = await sentKey(false);
  return Promise.all(rows.map(r => openSent(r, key)));
};

const ZCASH_DB = 'zafu-zcash';

/** the worker's database, or null when there is none yet (never created from here) */
export const openZcashDb = (): Promise<IDBDatabase | null> =>
  new Promise(resolve => {
    try {
      const req = indexedDB.open(ZCASH_DB);
      req.onupgradeneeded = () => req.transaction?.abort();
      req.onsuccess = () => {
        const db = req.result;
        if (db.objectStoreNames.contains('sent')) {
          db.onversionchange = () => db.close();
          resolve(db);
        } else {
          db.close();
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

const done = (tx: IDBTransaction): Promise<boolean> =>
  new Promise(resolve => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });

const same = (a: Private, b: Private) =>
  a.recipient === b.recipient &&
  a.memo === b.memo &&
  JSON.stringify(a.payments) === JSON.stringify(b.payments);

/**
 * Seal every plain record: ones written while locked, by an older version, or
 * by a restore. Nothing happens while locked; the records wait, whole. A
 * record that changed while it was being sealed is left for the next pass.
 */
export const sealSentRecords = async (): Promise<void> => {
  const db = await openZcashDb();
  if (!db) {
    return;
  }
  try {
    const read = db.transaction('sent', 'readonly').objectStore('sent').getAll();
    const plain = (
      await new Promise<SentTxRecord[]>(resolve => {
        read.onsuccess = () => resolve((read.result as SentTxRecord[] | undefined) ?? []);
        read.onerror = () => resolve([]);
      })
    ).filter(isPlain);
    const key = plain.length ? await sentKey(true) : null;
    if (!key) {
      return;
    }
    const sealed = await Promise.all(plain.map(r => sealSent(r, key)));
    const tx = db.transaction('sent', 'readwrite');
    const store = tx.objectStore('sent');
    plain.forEach((was, i) => {
      const now = store.get([was.walletId, was.txid]);
      now.onsuccess = () => {
        const cur = now.result as SentTxRecord | undefined;
        if (cur && isPlain(cur) && same(cur, was)) {
          const { recipient: _r, memo: _m, payments: _p, ...rest } = cur;
          store.put({ ...rest, sealed: sealed[i]!.sealed });
        }
      };
    });
    await done(tx);
  } finally {
    db.close();
  }
};
