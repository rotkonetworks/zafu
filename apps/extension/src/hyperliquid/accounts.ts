/**
 * A seed wallet's Hyperliquid accounts: the standard EVM account indices of
 * the seed, m/44'/60'/0'/0/n. Account 0 is the wallet's one EVM address.
 * Standard on purpose: any EVM wallet opens the same accounts from the
 * phrase, which is the last-resort way back to them.
 *
 * A new account is always the next index, so there are no gaps and a scan
 * (scanAccounts) finds them all from the seed alone. What is kept is only
 * the highest index handed out and the names; both ride the settings backup,
 * and a restore never lowers the index. A custom key path (v1's "advanced")
 * is one extra account beside the indexed ones, never in place of them.
 */

import { localExtStorage } from '@repo/storage-chrome/local';
import { isBip32Path } from '@repo/wallet/networks/hyperliquid/derive';

/** an account index, or the one imported path */
export type AccountId = number | 'path';

export interface WalletAccounts {
  /** the highest index handed out; 0 for a wallet that never made another */
  top: number;
  /** by index, or 'path'; an account without one goes by its number */
  names: Record<string, string>;
  active?: AccountId;
}

/** by wallet owner (state/pockets pocketOwner), so a re-imported seed finds its own */
export type AccountsBook = Record<string, WalletAccounts>;

/** non-hardened BIP-32 indices are below 2^31 */
const MAX_INDEX = 0x7fffffff;
const isIndex = (n: unknown): n is number =>
  Number.isInteger(n) && (n as number) >= 0 && (n as number) <= MAX_INDEX;
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const parseWallet = (v: unknown): WalletAccounts | undefined => {
  if (!isObj(v) || !isIndex(v['top'])) {
    return undefined;
  }
  const names = Object.fromEntries(
    Object.entries(isObj(v['names']) ? v['names'] : {}).filter(
      (e): e is [string, string] =>
        typeof e[1] === 'string' && !!e[1] && (e[0] === 'path' || isIndex(Number(e[0]))),
    ),
  );
  const active = v['active'];
  return {
    top: v['top'],
    names,
    ...(active === 'path' || isIndex(active) ? { active } : {}),
  };
};

/** whatever storage or a backup holds, read loosely: only well-formed wallets survive */
export const parseBook = (v: unknown): AccountsBook =>
  Object.fromEntries(
    Object.entries(isObj(v) ? v : {}).flatMap(([owner, w]) => {
      const parsed = parseWallet(w);
      return parsed ? [[owner, parsed]] : [];
    }),
  );

const NONE: WalletAccounts = { top: 0, names: {} };
export const accountsOf = (book: AccountsBook, owner: string | undefined): WalletAccounts =>
  (owner && book[owner]) || NONE;

export const accountPath = (index: number): string => `m/44'/60'/0'/0/${index}`;

/** a stored custom path, when it is one */
export const customPathOf = (stored: unknown): string | undefined =>
  typeof stored === 'string' && isBip32Path(stored) ? stored : undefined;

/** the account in use: one that exists, else account 0 */
export const activeOf = (w: WalletAccounts, customPath: string | undefined): AccountId =>
  w.active === 'path'
    ? customPath
      ? 'path'
      : 0
    : w.active !== undefined && w.active <= w.top
      ? w.active
      : 0;

export const pathOf = (id: AccountId, customPath: string | undefined): string =>
  id === 'path' ? (customPath ?? accountPath(0)) : accountPath(id);

export const nameOf = (w: WalletAccounts, id: AccountId): string =>
  w.names[String(id)] ?? (id === 'path' ? 'imported path' : id === 0 ? 'main' : `account ${id}`);

export interface AccountRow {
  id: AccountId;
  name: string;
  /** under the name: which key it is */
  sub: string;
}

/** every indexed account in order, then the imported path when there is one */
export const rowsOf = (w: WalletAccounts, customPath: string | undefined): AccountRow[] => [
  ...Array.from({ length: w.top + 1 }, (_, i) => ({
    id: i,
    name: nameOf(w, i),
    sub: `account ${i}`,
  })),
  ...(customPath ? [{ id: 'path' as const, name: nameOf(w, 'path'), sub: customPath }] : []),
];

/** the next index, with no gap, made the one in use */
export const withNew = (w: WalletAccounts): WalletAccounts =>
  w.top >= MAX_INDEX ? w : { ...w, top: w.top + 1, active: w.top + 1 };

/** the highest index only ever goes up */
export const withTop = (w: WalletAccounts, top: number): WalletAccounts =>
  isIndex(top) && top > w.top ? { ...w, top } : w;

export const withName = (w: WalletAccounts, id: AccountId, name: string): WalletAccounts => {
  const { [String(id)]: _, ...rest } = w.names;
  const trimmed = name.trim();
  return { ...w, names: trimmed ? { ...rest, [String(id)]: trimmed } : rest };
};

/**
 * A backup over what is here: each wallet's highest index is the larger of
 * the two (lowering it would hide an account that may hold funds), the
 * backup's names win, and the account in use stays the one here.
 */
export const mergeRestored = (current: AccountsBook, incoming: unknown): AccountsBook => {
  const next = { ...current };
  for (const [owner, theirs] of Object.entries(parseBook(incoming))) {
    const ours = accountsOf(current, owner);
    next[owner] = {
      top: Math.max(ours.top, theirs.top),
      names: { ...ours.names, ...theirs.names },
      ...(ours.active !== undefined ? { active: ours.active } : {}),
    };
  }
  return next;
};

/** how many accounts in a row must be unknown to Hyperliquid before the search stops */
export const SCAN_GAP = 5;

/**
 * Look for accounts from the seed alone: indices in order, one question
 * each, until `gap` in a row were never used. Resolves the highest index
 * found, or -1 when there is none. `exists` throws when it could not ask;
 * that stops the search rather than reading silence as empty.
 */
export const scanAccounts = async (
  exists: (index: number) => Promise<boolean>,
  gap = SCAN_GAP,
): Promise<number> => {
  let found = -1;
  for (let index = 0; index - found <= gap; index++) {
    if (await exists(index)) {
      found = index;
    }
  }
  return found;
};

const KEY = 'hyperliquidAccounts';

export const readBook = async (): Promise<AccountsBook> =>
  parseBook(await localExtStorage.get(KEY));

/** change one wallet's accounts; the lock keeps two popups from undoing each other */
export const changeAccounts = async (
  owner: string,
  change: (w: WalletAccounts) => WalletAccounts,
): Promise<AccountsBook> =>
  await navigator.locks.request(`${chrome.runtime.id}.${KEY}`, { mode: 'exclusive' }, async () => {
    const book = await readBook();
    const next = { ...book, [owner]: change(accountsOf(book, owner)) };
    await localExtStorage.set(KEY, next);
    return next;
  });
