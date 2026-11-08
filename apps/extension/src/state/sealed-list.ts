/**
 * A list of records kept sealed at rest (the key must be in ENCRYPTED_KEYS):
 * read, and changed one read-modify-write at a time under a lock every realm
 * shares. A locked wallet reads as none and writes nothing; a box that won't
 * open is kept aside by readEncryptedWithMigration, never overwritten in
 * place. Open swaps and open payments are each one.
 */

import { localExtStorage, type LocalStorageState } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { readEncrypted, readEncryptedWithMigration, writeEncrypted } from './encrypted-storage';

export interface SealedList<T extends { id: string }> {
  /** the records; [] when locked or none, never a crash on the home screen */
  read: () => Promise<T[]>;
  /** remember a record, or replace the one with its id; false when locked */
  save: (t: T) => Promise<boolean>;
  /** update one record in place; nothing when it is gone */
  patch: (id: string, patch: Partial<T>) => Promise<boolean>;
  forget: (id: string) => Promise<boolean>;
  /** call `fn` whenever the list changes in any realm */
  onChange: (fn: () => void) => () => void;
}

export const sealedList = <T extends { id: string }>(
  key: string,
  isRecord: (v: unknown) => v is T,
  /** dropped on every write */
  isStale: (t: T) => boolean = () => false,
  lockName = key,
): SealedList<T> => {
  const K = key as keyof LocalStorageState;
  const read = async (): Promise<T[]> => {
    if (!(await sessionExtStorage.get('passwordKey'))) {
      return [];
    }
    const v = await readEncrypted<unknown>(localExtStorage, sessionExtStorage, K).catch(() => null);
    return Array.isArray(v) ? v.filter(isRecord) : [];
  };
  const change = async (fn: (list: T[]) => T[]): Promise<boolean> =>
    navigator.locks.request(`${chrome.runtime.id}.${lockName}`, { mode: 'exclusive' }, async () => {
      if (!(await sessionExtStorage.get('passwordKey'))) {
        return false;
      }
      const v = await readEncryptedWithMigration<unknown>(localExtStorage, sessionExtStorage, K);
      const list = Array.isArray(v) ? v.filter(isRecord) : [];
      const next = fn(list).filter(t => !isStale(t));
      if (!next.length) {
        await chrome.storage.local.remove(key);
        return true;
      }
      return writeEncrypted(localExtStorage, sessionExtStorage, K, next);
    });
  return {
    read,
    save: t => change(list => [...list.filter(x => x.id !== t.id), t]),
    patch: (id, patch) => change(list => list.map(t => (t.id === id ? { ...t, ...patch } : t))),
    forget: id => change(list => list.filter(t => t.id !== id)),
    onChange: fn => {
      const l = (changes: Record<string, chrome.storage.StorageChange>) => {
        if (key in changes) {
          fn();
        }
      };
      chrome.storage.local.onChanged.addListener(l);
      return () => chrome.storage.local.onChanged.removeListener(l);
    },
  };
};
