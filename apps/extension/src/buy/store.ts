/**
 * Where the open buy lives between visits: sealed in local storage
 * (ENCRYPTED_KEYS 'openBuy'), so the seller's handle, the Base address and
 * the deposit address are never at rest in the clear. A locked wallet reads
 * as no open buy. It is not a setting, so it is not in the personal backup.
 *
 * The person's last payment app and currency are plain conveniences
 * (`buyPrefs`), like a remembered tab.
 */

import { localExtStorage, type LocalStorageState } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { readEncrypted, writeEncrypted } from '../state/encrypted-storage';
import type { OpenBuy } from './machine';

export const OPEN_BUY_KEY = 'openBuy';
const OPEN = OPEN_BUY_KEY as keyof LocalStorageState;
const PREFS = 'buyPrefs';

/** a stored value is a buy only if it has the shape this build writes */
export const isOpenBuy = (v: unknown): v is OpenBuy =>
  !!v &&
  typeof v === 'object' &&
  (v as OpenBuy).v === 1 &&
  typeof (v as OpenBuy).stage === 'string' &&
  typeof (v as OpenBuy).offer === 'object' &&
  typeof (v as OpenBuy).base === 'string';

export const readOpenBuy = async (): Promise<OpenBuy | null> => {
  if (!(await sessionExtStorage.get('passwordKey'))) {
    return null;
  }
  // a box that will not open (another password, a damaged write) is no buy,
  // never a crash on the home screen
  const v = await readEncrypted<unknown>(localExtStorage, sessionExtStorage, OPEN).catch(
    () => null,
  );
  return isOpenBuy(v) ? v : null;
};

/** seal the buy; null forgets it. False when the wallet is locked (nothing written). */
export const writeOpenBuy = async (b: OpenBuy | null): Promise<boolean> => {
  if (!b) {
    await chrome.storage.local.remove(OPEN_BUY_KEY);
    return true;
  }
  return writeEncrypted(localExtStorage, sessionExtStorage, OPEN, b);
};

/** call `fn` whenever the open buy changes in any realm */
export const onOpenBuyChange = (fn: () => void): (() => void) => {
  const l = (changes: Record<string, chrome.storage.StorageChange>) => {
    if (OPEN_BUY_KEY in changes) {
      fn();
    }
  };
  chrome.storage.local.onChanged.addListener(l);
  return () => chrome.storage.local.onChanged.removeListener(l);
};

export interface BuyPrefs {
  app?: string;
  currency?: string;
  /** apps whose read access the person chose to keep */
  kept?: string[];
  /** when that kept access is given back (see capture/kept.ts) */
  keptUntil?: number;
}

export const readBuyPrefs = async (): Promise<BuyPrefs> => {
  const v = (await chrome.storage.local.get(PREFS))[PREFS] as unknown;
  return v && typeof v === 'object' ? (v as BuyPrefs) : {};
};

export const writeBuyPrefs = async (patch: BuyPrefs): Promise<void> => {
  await chrome.storage.local.set({ [PREFS]: { ...(await readBuyPrefs()), ...patch } });
};
