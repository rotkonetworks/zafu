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
import { nextHdIndex, raiseHdIndex } from '@repo/storage-chrome/cosmos-chain-counters';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import {
  readEncrypted,
  readEncryptedWithMigration,
  writeEncrypted,
} from '../state/encrypted-storage';
import { parsePocketStoreId, pocketStoreId, zcashTransparentIndexKey } from '../state/pocket-id';
import { isDone, isFlight, StaleFlight, type Flight } from './flight';

export const LP_KEY = 'zecLp';
const KEY = LP_KEY as keyof LocalStorageState;

/** the last read of a position: what the home card shows */
export interface LpCache {
  /** worth now if taken out, after the pool's fee, zat */
  zat: string;
  sharePct: number;
  readAt: number;
}

/**
 * The pocket's rune account for adding with rune too: present only once the
 * person chose it on lp.html. `on: false` is "stop using rune here": nothing
 * is read or shown, and the index stays so a later opt-in brings back the same
 * thor1 (it is seed-derived, m/44'/931'/0'/0/index; no key is ever stored).
 */
export interface LpRune {
  index: number;
  on: boolean;
  /** the derived thor1, kept while on; derived again in the worker when missing */
  address?: string;
}

export interface LpPocket {
  /** t-branch index of the pocket's lp address */
  index: number;
  address?: string;
  cache?: LpCache;
  flight?: Flight;
  rune?: LpRune;
}

/** the HD counter the rune accounts are handed out from; written only on an opt-in */
export const RUNE_COUNTER = 'thorchain-lp';

const isRune = (v: unknown): v is LpRune =>
  !!v &&
  typeof v === 'object' &&
  Number.isSafeInteger((v as LpRune).index) &&
  (v as LpRune).index > 0 &&
  typeof (v as LpRune).on === 'boolean';

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
        ...(isRune(p.rune)
          ? {
              rune: {
                index: p.rune.index,
                on: p.rune.on,
                ...(p.rune.on && typeof p.rune.address === 'string'
                  ? { address: p.rune.address }
                  : {}),
              },
            }
          : {}),
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

/**
 * Write a flight over the stored one it was made from: the same id and rev.
 * Hands back what was written (its rev one higher); throws StaleFlight when
 * the stored flight moved on, or when locked. `after` a broadcast it writes
 * over any rev of the same flight, since the txid is the truth then.
 */
export const saveFlight = async (storeId: string, f: Flight, after = false): Promise<Flight> => {
  let out: Flight | undefined;
  await changeLp(book => {
    const p = book[storeId];
    const cur = p?.flight;
    if (!p || cur?.id !== f.id || (!after && (cur.rev ?? 0) !== (f.rev ?? 0))) {
      return book;
    }
    out = { ...f, rev: (cur.rev ?? 0) + 1 };
    return { ...book, [storeId]: { ...p, flight: out } };
  });
  if (!out) {
    throw new StaleFlight();
  }
  return out;
};

/**
 * Change the stored flight in place, under the lock: `fn` sees what is
 * stored now, not a copy from earlier. Its answer is written (undefined
 * clears it); `false` leaves it. Hands back what is stored after.
 */
export const changeFlight = async (
  storeId: string,
  fn: (f: Flight | undefined) => Flight | undefined | false,
): Promise<Flight | undefined> => {
  let out: Flight | undefined;
  await changeLp(book => {
    const p = book[storeId];
    if (!p) {
      return book;
    }
    const next = fn(p.flight);
    out = next === false ? p.flight : next && { ...next, rev: (p.flight?.rev ?? 0) + 1 };
    return next === false ? book : { ...book, [storeId]: { ...p, flight: out } };
  });
  return out;
};

/** start a flight only when none is on its way in any tab: what was stored, or undefined when one is */
export const beginFlight = async (storeId: string, f: Flight): Promise<Flight | undefined> => {
  const out = await changeFlight(storeId, cur => (cur && !isDone(cur) ? false : f));
  return out?.id === f.id ? out : undefined;
};

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

/**
 * The person chose "add with rune too" for this pocket: its rune index, the
 * one it had before when it was turned off, else the next from the counter.
 * The address is derived by the caller (in the worker) and patched in.
 */
export const optInRune = async (storeId: string): Promise<LpRune | undefined> => {
  const had = (await readLpPocket(storeId))?.rune;
  const index = had?.index ?? (await nextHdIndex(RUNE_COUNTER));
  let out: LpRune | undefined;
  await changeLp(book => {
    const p = book[storeId];
    if (!p) {
      return book;
    }
    out = {
      index: p.rune?.index ?? index,
      on: true,
      address: p.rune?.on ? p.rune.address : undefined,
    };
    return { ...book, [storeId]: { ...p, rune: out } };
  });
  return out;
};

/** "stop using rune here": the opt-in is forgotten, the index kept for a later one */
export const optOutRune = (storeId: string): Promise<boolean> =>
  changeLp(book => {
    const p = book[storeId];
    return p?.rune
      ? { ...book, [storeId]: { ...p, rune: { index: p.rune.index, on: false } } }
      : book;
  });

/** the backup's rune part: owner -> account -> { index, on }; undefined when no pocket ever opted in */
export type LpRuneBackup = Record<string, Record<string, { index: number; on: boolean }>>;

export const exportLpRune = async (
  ownerOf: (walletId: string) => string | undefined,
): Promise<LpRuneBackup | undefined> => {
  const out: LpRuneBackup = {};
  for (const [storeId, p] of Object.entries(await readLp())) {
    const owner = p.rune && ownerOf(parsePocketStoreId(storeId).walletId);
    if (p.rune && owner) {
      (out[owner] ??= {})[String(parsePocketStoreId(storeId).account)] = {
        index: p.rune.index,
        on: p.rune.on,
      };
    }
  }
  return Object.keys(out).length ? out : undefined;
};

/** put the rune opt-ins back on pockets that have an lp record, and raise the counter past them */
export const restoreLpRune = async (
  backup: unknown,
  walletOf: (owner: string) => string | undefined,
) => {
  if (!backup || typeof backup !== 'object') {
    return;
  }
  const add: Record<string, LpRune> = {};
  for (const [owner, pockets] of Object.entries(backup as Record<string, unknown>)) {
    const walletId = walletOf(owner);
    if (!walletId || !pockets || typeof pockets !== 'object') {
      continue;
    }
    for (const [acct, r] of Object.entries(pockets as Record<string, unknown>)) {
      const account = Number(acct);
      if (isRune(r) && Number.isInteger(account)) {
        add[pocketStoreId(walletId, account)] = { index: r.index, on: r.on };
        await raiseHdIndex(RUNE_COUNTER, r.index);
      }
    }
  }
  if (!Object.keys(add).length) {
    return;
  }
  await changeLp(book => {
    const next = { ...book };
    for (const [id, r] of Object.entries(add)) {
      const p = next[id];
      if (p && !p.rune) {
        next[id] = { ...p, rune: r };
      }
    }
    return next;
  });
};
