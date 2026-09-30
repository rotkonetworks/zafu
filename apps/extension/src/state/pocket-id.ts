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
