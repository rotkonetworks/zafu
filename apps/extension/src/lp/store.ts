/**
 * What zafu keeps about zec liquidity, per pocket store: the pocket's one lp
 * address (its t-branch index, claimed once from the same counter swaps use,
 * so the funds scan covers it), the last read of the position (the home card
 * shows only this; nothing is fetched on home load), and the add or take-out
 * in flight.
 *
 * Sealed at rest (ENCRYPTED_KEYS 'zecLp'): a locked wallet reads as nothing
 * and writes nothing. The index is in the personal backup: a position is
 * credited to its address, and after a restore that address must come back.
 */

import { localExtStorage, type LocalStorageState } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import {
  readEncrypted,
  readEncryptedWithMigration,
  writeEncrypted,
} from '../state/encrypted-storage';
import { parsePocketStoreId, pocketStoreId, zcashTransparentIndexKey } from '../state/pocket-id';
import { isFlight, type Flight } from './flight';

export const LP_KEY = 'zecLp';
const KEY = LP_KEY as keyof LocalStorageState;

/** the last read of a position: what the home card shows */
export interface LpCache {
  /** worth now if taken out, after the pool's fee, zat */
  zat: string;
  sharePct: number;
  readAt: number;
}

export interface LpPocket {
  /** t-branch index of the pocket's lp address */
  index: number;
  address?: string;
  cache?: LpCache;
  flight?: Flight;
}

export type LpBook = Record<string, LpPocket>;

const isPocket = (v: unknown): v is LpPocket =>
  !!v &&
  typeof v === 'object' &&
  Number.isInteger((v as LpPocket).index) &&
  (v as LpPocket).index > 0;

/** keep only what has this build's shape; a damaged flight is dropped, never the index */
const clean = (v: unknown): LpBook => {
  const book: LpBook = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return book;
  }
  for (const [id, p] of Object.entries(v as Record<string, unknown>)) {
    if (isPocket(p)) {
      book[id] = {
        index: p.index,
        address: typeof p.address === 'string' ? p.address : undefined,
        cache:
          p.cache && typeof p.cache.zat === 'string' && typeof p.cache.readAt === 'number'
            ? p.cache
            : undefined,
        flight: isFlight(p.flight) ? p.flight : undefined,
      };
    }
  }
  return book;
};

const unlocked = async () => !!(await sessionExtStorage.get('passwordKey'));

/** every pocket's lp record; empty when locked or none, never a crash on the home screen */
export const readLp = async (): Promise<LpBook> => {
  if (!(await unlocked())) {
    return {};
  }
  return clean(
    await readEncrypted<unknown>(localExtStorage, sessionExtStorage, KEY).catch(() => null),
  );
};

export const readLpPocket = async (storeId: string): Promise<LpPocket | undefined> =>
  (await readLp())[storeId];

/**
 * One change to the book, read-modify-write under a lock every realm shares.
 * False when locked (nothing written). A box that won't open is kept aside,
 * never overwritten in place.
 */
export const changeLp = async (fn: (book: LpBook) => LpBook): Promise<boolean> =>
  navigator.locks.request(`${chrome.runtime.id}.zec-lp`, { mode: 'exclusive' }, async () => {
    if (!(await unlocked())) {
      return false;
    }
    const v = await readEncryptedWithMigration<unknown>(localExtStorage, sessionExtStorage, KEY);
    return await writeEncrypted(localExtStorage, sessionExtStorage, KEY, fn(clean(v)));
  });

export const patchLpPocket = (storeId: string, patch: Partial<LpPocket>): Promise<boolean> =>
  changeLp(book => {
    const p = book[storeId];
    return p ? { ...book, [storeId]: { ...p, ...patch } } : book;
  });

/** call `fn` whenever the book changes in any realm */
export const onLpChange = (fn: () => void): (() => void) => {
  const l = (changes: Record<string, chrome.storage.StorageChange>) => {
    if (LP_KEY in changes) {
      fn();
    }
  };
  chrome.storage.local.onChanged.addListener(l);
  return () => chrome.storage.local.onChanged.removeListener(l);
};

/** the backup's part: each wallet's pockets' lp indices, keyed by the wallet's owner key */
export type LpBackup = Record<string, Record<string, number>>;

export const exportLp = async (ownerOf: (walletId: string) => string | undefined) => {
  const out: LpBackup = {};
  for (const [storeId, p] of Object.entries(await readLp())) {
    const { walletId, account } = parsePocketStoreId(storeId);
    const owner = ownerOf(walletId);
    if (owner) {
      (out[owner] ??= {})[String(account)] = p.index;
    }
  }
  return out;
};

/** the highest t-index handed out for a pocket, raised so the scan and the next swap see `index` */
const raiseTIndex = async (account: number, index: number) => {
  const key = zcashTransparentIndexKey(account);
  await navigator.locks.request(
    `${chrome.runtime.id}.zcash-t-index`,
    { mode: 'exclusive' },
    async () => {
      const v: unknown = (await chrome.storage.local.get(key))[key];
      if (!Number.isInteger(v) || (v as number) < index) {
        await chrome.storage.local.set({ [key]: index });
      }
    },
  );
};

/**
 * Restore the indices for the wallets here. A pocket that already has an lp
 * address keeps it; the address itself is derived again on lp.html.
 */
export const restoreLp = async (
  backup: unknown,
  walletOf: (owner: string) => string | undefined,
) => {
  if (!backup || typeof backup !== 'object') {
    return;
  }
  const add: LpBook = {};
  for (const [owner, pockets] of Object.entries(backup as Record<string, unknown>)) {
    const walletId = walletOf(owner);
    if (!walletId || !pockets || typeof pockets !== 'object') {
      continue;
    }
    for (const [acct, index] of Object.entries(pockets as Record<string, unknown>)) {
      const account = Number(acct);
      if (Number.isInteger(index) && (index as number) > 0 && Number.isInteger(account)) {
        add[pocketStoreId(walletId, account)] = { index: index as number };
        await raiseTIndex(account, index as number);
      }
    }
  }
  await changeLp(book => {
    const next = { ...book };
    for (const [id, p] of Object.entries(add)) {
      next[id] ??= p;
    }
    return next;
  });
};
