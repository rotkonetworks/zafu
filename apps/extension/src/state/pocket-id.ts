/**
 * Pocket store ids: which zcash worker store a pocket (ZIP 32 account) of a
 * wallet syncs into. Dependency-free so the worker can import it.
 *
 * Account 0 keeps the bare wallet id, so existing stores need no migration.
 */

/** ZIP 32 hardened account indices are below 2^31 */
const MAX_ACCOUNT = 0x7fffffff;
const SEP = '#';
const POCKET_ID = /^(.+)#([1-9]\d*)$/;

export const isAccountIndex = (n: unknown): n is number =>
  Number.isInteger(n) && (n as number) >= 0 && (n as number) <= MAX_ACCOUNT;

const assertAccount = (account: number) => {
  if (!isAccountIndex(account)) {
    throw new Error(`invalid zip32 account index: ${account}`);
  }
};

/** worker store id for a wallet's pocket; account 0 is the bare wallet id */
export const pocketStoreId = (walletId: string, account: number): string => {
  assertAccount(account);
  return account === 0 ? walletId : `${walletId}${SEP}${account}`;
};

/** inverse of pocketStoreId; anything not in canonical pocket form is account 0 */
export const parsePocketStoreId = (storeId: string): { walletId: string; account: number } => {
  const m = POCKET_ID.exec(storeId);
  const account = m ? Number(m[2]) : 0;
  return m && isAccountIndex(account)
    ? { walletId: m[1]!, account }
    : { walletId: storeId, account: 0 };
};

/** true when `storeId` belongs to `walletId` (its account 0 or any pocket) */
export const isStoreOfWallet = (storeId: string, walletId: string): boolean =>
  parsePocketStoreId(storeId).walletId === walletId;

/**
 * The ZIP 32 account a hot (seed) build must sign with: always the account of
 * the store the notes were loaded from. A caller-supplied account that
 * disagrees is refused before anything is built, so pocket 1 can never spend
 * pocket 0 notes (or the reverse).
 */
export const hotSpendAccount = (storeId: string, requested?: number): number => {
  const { account } = parsePocketStoreId(storeId);
  if (requested !== undefined && requested !== account) {
    throw new Error(`pocket mismatch: notes belong to account ${account}, not ${requested}`);
  }
  return account;
};

/**
 * chrome.storage key of the highest transparent address index ever handed
 * out: by an older build's rotation, or by a swap claiming its own fresh
 * address (hooks/use-transparent-addresses claimSwapTAddress). It widens the
 * funds scan to cover every one of them. Account 0 keeps the historic global
 * key so existing addresses never shift.
 */
export const zcashTransparentIndexKey = (account: number): string =>
  account === 0 ? 'zcashTransparentIndex' : `zcashTransparentIndex#${account}`;

/** older builds rotated t-addresses; the first twenty were always scanned */
const LEGACY_T_FLOOR = 19;

/**
 * Every t-branch index scanned for a pocket's funds. A pocket shows one
 * address, index 0, but older builds and swaps handed out more and those may
 * still hold coins, so the scan covers up to the highest index ever stored.
 * Array position is the derivation index: never filter or reorder it.
 */
export const pocketTransparentIndices = (legacyMax: unknown): number[] => {
  const max = Number.isInteger(legacyMax)
    ? Math.max(LEGACY_T_FLOOR, legacyMax as number)
    : LEGACY_T_FLOOR;
  return Array.from({ length: max + 1 }, (_, i) => i);
};
