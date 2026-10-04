/**
 * Zcash pockets: named ZIP 32 accounts (m/32'/133'/a') inside one hot wallet,
 * each with its own transparent branch (m/44'/133'/a'/0/i).
 *
 * Storage isolation is structural: every pocket syncs into its own zcash
 * worker store, keyed by `pocketStoreId`. Account 0 keeps the bare wallet id,
 * so existing wallets need no migration. Viewing-key, zigner, ledger and
 * multisig wallets are single-account: their account comes from the key.
 */

import type { AllSlices, SliceCreator } from '.';
import type { ExtensionStorage } from '@repo/storage-chrome/base';
import type { LocalStorageState } from '@repo/storage-chrome/local';
import { selectEffectiveKeyInfo } from './keyring';
import type { KeyInfo } from './keyring/types';
import { selectActiveZcashWallet } from './wallets';
import { isAccountIndex, pocketStoreId } from './pocket-id';

/** open question: the cap keeps scanning cost bounded (see report) */
export const MAX_POCKETS = 10;

export interface Pocket {
  account: number;
  name: string;
  /** first height worth scanning; absent = the wallet's own birthday */
  birthday?: number;
  /** hidden from pocket lists (accounts sheet, send from, receive); it keeps
   * syncing and its balance, and only unhide brings it back into view */
  hidden?: boolean;
}

export interface WalletPockets {
  pockets: Pocket[];
  active: number;
}

/** pocket owner (see pocketOwner) -> its pockets */
export type PocketBook = Record<string, WalletPockets>;

export const POCKETS_STORAGE_KEY = 'zcashPockets';
const MAIN: Pocket = { account: 0, name: 'main' };

/** a wallet's pockets; a wallet nobody has touched has just "main" */
export const pocketsOf = (book: PocketBook, owner: string): Pocket[] =>
  book[owner]?.pockets ?? [MAIN];

/** the active account, falling back to 0 if it points at no pocket */
export const activePocketOf = (book: PocketBook, owner: string): number => {
  const entry = book[owner];
  return entry?.pockets.some(p => p.account === entry.active) ? entry.active : 0;
};

/** indices are never reused: a new pocket takes max + 1 */
export const addPocket = (
  book: PocketBook,
  owner: string,
  name: string,
  birthday?: number,
): PocketBook => {
  const pockets = pocketsOf(book, owner);
  if (pockets.length >= MAX_POCKETS) {
    throw new Error(`at most ${MAX_POCKETS} pockets`);
  }
  const account = Math.max(...pockets.map(p => p.account)) + 1;
  const pocket: Pocket = {
    account,
    name: name.trim() || `pocket ${account}`,
    ...(birthday ? { birthday } : {}),
  };
  return {
    ...book,
    [owner]: { pockets: [...pockets, pocket], active: activePocketOf(book, owner) },
  };
};

export const renamePocket = (
  book: PocketBook,
  owner: string,
  account: number,
  name: string,
): PocketBook => {
  const trimmed = name.trim();
  const pockets = pocketsOf(book, owner);
  if (!trimmed || !pockets.some(p => p.account === account)) {
    return book;
  }
  return {
    ...book,
    [owner]: {
      pockets: pockets.map(p => (p.account === account ? { ...p, name: trimmed } : p)),
      active: activePocketOf(book, owner),
    },
  };
};

export const selectPocket = (book: PocketBook, owner: string, account: number): PocketBook =>
  pocketsOf(book, owner).some(p => p.account === account)
    ? { ...book, [owner]: { pockets: pocketsOf(book, owner), active: account } }
    : book;

/** pockets a list should show: main plus anything not hidden */
export const visiblePockets = (pockets: Pocket[]): Pocket[] => pockets.filter(p => !p.hidden);

export const hiddenPockets = (pockets: Pocket[]): Pocket[] => pockets.filter(p => p.hidden);

/**
 * Hide a pocket (never deleted: it keeps syncing, its name and balance stay).
 * Main (account 0) can never be hidden. Hiding the active pocket switches
 * the active one to main first, rather than leaving the sheet pointed at a
 * pocket no longer listed - the calmer of the two options the founder asked
 * to pick between.
 */
export const hidePocket = (book: PocketBook, owner: string, account: number): PocketBook => {
  if (account === 0) {
    return book;
  }
  const pockets = pocketsOf(book, owner);
  if (!pockets.some(p => p.account === account)) {
    return book;
  }
  const active = activePocketOf(book, owner);
  return {
    ...book,
    [owner]: {
      pockets: pockets.map(p => (p.account === account ? { ...p, hidden: true } : p)),
      active: active === account ? 0 : active,
    },
  };
};

export const unhidePocket = (book: PocketBook, owner: string, account: number): PocketBook => {
  const pockets = pocketsOf(book, owner);
  if (!pockets.some(p => p.account === account)) {
    return book;
  }
  return {
    ...book,
    [owner]: {
      pockets: pockets.map(p => {
        if (p.account !== account) {
          return p;
        }
        const { hidden: _hidden, ...rest } = p;
        return rest;
      }),
      active: activePocketOf(book, owner),
    },
  };
};

/** drop a wallet's pockets (wallet removal) */
export const forgetWallet = (book: PocketBook, owner: string): PocketBook => {
  const { [owner]: _gone, ...rest } = book;
  return rest;
};

const isPocket = (p: unknown): p is Pocket => {
  const o = p as Partial<Pocket> | null;
  return (
    !!o &&
    isAccountIndex(o.account) &&
    typeof o.name === 'string' &&
    (o.birthday === undefined || (Number.isInteger(o.birthday) && o.birthday > 0)) &&
    (o.hidden === undefined || typeof o.hidden === 'boolean')
  );
};

/** main can never be hidden, even if untrusted input (storage or a backup) says so */
const neverHideMain = (p: Pocket): Pocket => {
  if (p.account !== 0 || !p.hidden) {
    return p;
  }
  const { hidden: _hidden, ...rest } = p;
  return rest;
};

/** validate untrusted input (storage or a backup file); bad rows are dropped */
export const sanitizePocketBook = (raw: unknown): PocketBook => {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const out: PocketBook = {};
  for (const [owner, entry] of Object.entries(raw as Record<string, Partial<WalletPockets>>)) {
    const seen = new Set<number>();
    const pockets = (Array.isArray(entry?.pockets) ? entry.pockets : [])
      .filter(isPocket)
      .filter(p => !seen.has(p.account) && seen.add(p.account))
      .map(neverHideMain)
      .slice(0, MAX_POCKETS);
    if (!pockets.some(p => p.account === 0)) {
      pockets.unshift(MAIN);
    }
    const active = pockets.some(p => p.account === entry?.active && !p.hidden) ? entry.active! : 0;
    out[owner] = { pockets: pockets.slice(0, MAX_POCKETS), active };
  }
  return out;
};

/**
 * Restore from a backup. Pocket indices are key material (they pick the
 * ZIP 32 account), so a restore only ever adds pockets and names; it never
 * renumbers or drops a pocket that exists locally. 'replace' lets the
 * backup's names win, 'merge' keeps local names.
 */
export const mergePocketBooks = (
  local: PocketBook,
  incoming: PocketBook,
  mode: 'merge' | 'replace',
): PocketBook => {
  const out: PocketBook = { ...local };
  for (const [owner, theirs] of Object.entries(incoming)) {
    const mine = local[owner];
    if (!mine) {
      out[owner] = theirs;
      continue;
    }
    const byAccount = new Map(mine.pockets.map(p => [p.account, p]));
    for (const p of theirs.pockets) {
      const have = byAccount.get(p.account);
      byAccount.set(p.account, have && mode === 'merge' ? have : { ...have, ...p });
    }
    const pockets = [...byAccount.values()]
      .sort((a, b) => a.account - b.account)
      .slice(0, MAX_POCKETS);
    out[owner] = { pockets, active: mode === 'replace' ? theirs.active : mine.active };
  }
  return sanitizePocketBook(out);
};

export interface PocketsSlice {
  book: PocketBook;
  /** create a pocket on the next free account; returns its account */
  add: (owner: string, name: string, birthday?: number) => Promise<number>;
  rename: (owner: string, account: number, name: string) => Promise<void>;
  select: (owner: string, account: number) => Promise<void>;
  /** hide a pocket (never deletes it); switches off it first if it was active */
  hide: (owner: string, account: number) => Promise<void>;
  unhide: (owner: string, account: number) => Promise<void>;
  /** fold in pockets from a personal-data backup (untrusted input) */
  restore: (raw: unknown, mode: 'merge' | 'replace') => Promise<void>;
  /** load from storage (hydration and storage-change sync) */
  hydrate: (raw: unknown) => void;
}

type LK = keyof LocalStorageState;

export const createPocketsSlice =
  (local: ExtensionStorage<LocalStorageState>): SliceCreator<PocketsSlice> =>
  (set, get) => {
    const commit = async (book: PocketBook) => {
      set(state => {
        state.pockets.book = book;
      });
      await local.set(POCKETS_STORAGE_KEY as LK, book as never);
    };
    return {
      book: {},
      add: async (owner, name, birthday) => {
        const book = addPocket(get().pockets.book, owner, name, birthday);
        await commit(book);
        return Math.max(...pocketsOf(book, owner).map(p => p.account));
      },
      rename: (owner, account, name) =>
        commit(renamePocket(get().pockets.book, owner, account, name)),
      select: (owner, account) => commit(selectPocket(get().pockets.book, owner, account)),
      hide: (owner, account) => commit(hidePocket(get().pockets.book, owner, account)),
      unhide: (owner, account) => commit(unhidePocket(get().pockets.book, owner, account)),
      restore: (raw, mode) =>
        commit(mergePocketBooks(get().pockets.book, sanitizePocketBook(raw), mode)),
      hydrate: raw =>
        set(state => {
          state.pockets.book = sanitizePocketBook(raw);
        }),
    };
  };

/**
 * Which key a wallet's pockets are filed under: its ZID, which is derived from
 * the seed and so survives a reinstall or a move to a new device (vault ids do
 * not), falling back to the vault id for a vault that predates ZIDs.
 */
export const pocketOwner = (key: Pick<KeyInfo, 'id' | 'insensitive'>): string => {
  const zid = key.insensitive['zid'];
  return typeof zid === 'string' && zid ? zid : key.id;
};

const hotKey = (state: AllSlices) => {
  const key = selectEffectiveKeyInfo(state);
  return key?.type === 'mnemonic' ? key : undefined;
};

/**
 * The ZIP 32 account to operate on. Hot wallet: the active pocket. Any other
 * key: the account the key itself carries (single-account by construction).
 */
export const activeAccountIndex = (state: AllSlices): number => {
  const key = hotKey(state);
  return key
    ? activePocketOf(state.pockets.book, pocketOwner(key))
    : (selectActiveZcashWallet(state)?.accountIndex ?? 0);
};

/**
 * The zcash worker store id for the active wallet: the active pocket's store
 * for a hot wallet, the bare vault id for everything else (their store is
 * never split, whatever account their key names).
 */
export const activeZcashStoreId = (state: AllSlices): string | undefined => {
  const key = hotKey(state);
  return key
    ? pocketStoreId(key.id, activePocketOf(state.pockets.book, pocketOwner(key)))
    : selectEffectiveKeyInfo(state)?.id;
};

/** the active wallet's pockets (hot wallets only; others have none to pick) */
export const activePockets = (state: AllSlices): Pocket[] => {
  const key = hotKey(state);
  return key ? pocketsOf(state.pockets.book, pocketOwner(key)) : [];
};

/** first height the active pocket needs scanned; undefined = the wallet birthday */
export const activePocketBirthday = (state: AllSlices): number | undefined => {
  const key = hotKey(state);
  if (!key) {
    return undefined;
  }
  const owner = pocketOwner(key);
  const account = activePocketOf(state.pockets.book, owner);
  return account === 0
    ? undefined
    : pocketsOf(state.pockets.book, owner).find(p => p.account === account)?.birthday;
};
