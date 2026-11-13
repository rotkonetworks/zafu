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

const TESTNET = '@test';

/**
 * A seed wallet's store on one zcash chain. Mainnet keeps the bare wallet id;
 * testnet gets its own, so its notes, trees and tip never meet mainnet's.
 * Pockets go on top: `pocketStoreId(chainStoreId(id, false), 1)`.
 */
export const chainStoreId = (walletId: string, mainnet: boolean): string =>
  mainnet ? walletId : `${walletId}${TESTNET}`;

/** the chain a store syncs, read from its id */
export const storeIsMainnet = (storeId: string): boolean =>
  !parsePocketStoreId(storeId).walletId.endsWith(TESTNET);

/** true when `storeId` belongs to `walletId` (either chain, account 0 or any pocket) */
export const isStoreOfWallet = (storeId: string, walletId: string): boolean => {
  const id = parsePocketStoreId(storeId).walletId;
  return id === walletId || id === chainStoreId(walletId, false);
};

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
 * address (hooks/use-transparent-addresses claimSwapTAddress). The funds
 * check covers every one of them and no more. Account 0 keeps the historic global
 * key so existing addresses never shift.
 */
export const zcashTransparentIndexKey = (account: number): string =>
  account === 0 ? 'zcashTransparentIndex' : `zcashTransparentIndex#${account}`;

/**
 * Every t-branch index a pocket's checks ask about: index 0, the one it
 * shows, up to the highest ever handed out (a swap, an lp address, an older
 * build's rotation). Nothing past it is asked, so the node never hears of an
 * address zafu did not give out. Array position is the derivation index:
 * never filter or reorder it.
 */
export const pocketTransparentIndices = (highest: unknown): number[] => {
  const max = Number.isInteger(highest) && (highest as number) > 0 ? (highest as number) : 0;
  return Array.from({ length: max + 1 }, (_, i) => i);
};

/**
 * The highest index a restored seed looks back to: older builds rotated
 * through the first twenty, and a seed alone does not say which were used.
 */
export const RESTORE_T_INDEX = 19;
