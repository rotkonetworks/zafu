/**
 * Last-known penumbra balances, so the popup paints real numbers instantly
 * instead of "0" while the view service recomputes (a full balances stream
 * over every note - seconds on a wallet with hundreds of LP positions).
 *
 * Kept in chrome.storage.SESSION: memory only, cleared when the browser
 * closes. A privacy wallet must not write plaintext balances to disk; the cost
 * is that the first popup after a browser restart computes from scratch.
 *
 * Scoped to the exact wallet (vault + wallet index) and account, so one
 * wallet's numbers can never be shown for another. Always refreshed in the
 * background: the snapshot is only a starting point, never the answer.
 */

import { BalancesResponse } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { localExtStorage } from '@repo/storage-chrome/local';

const KEY = 'penumbraBalancesSnapshot';

interface StoredSnapshot {
  owner: string;
  account: number;
  at: number;
  items: string[];
}

const ownerKey = async (): Promise<string> => {
  const vault = await localExtStorage.get('selectedVaultId');
  const index = await localExtStorage.get('activeWalletIndex');
  return `${String(vault ?? '')}:${String(index ?? 0)}`;
};

export const saveBalancesSnapshot = async (
  account: number,
  balances: BalancesResponse[],
): Promise<void> => {
  try {
    const snapshot: StoredSnapshot = {
      owner: await ownerKey(),
      account,
      at: Date.now(),
      items: balances.map(b => b.toJsonString()),
    };
    await chrome.storage.session.set({ [KEY]: snapshot });
  } catch {
    // best effort: without a snapshot the popup just computes as before
  }
};

/** The snapshot for the currently selected wallet, or undefined. */
export const loadBalancesSnapshot = async (): Promise<
  { account: number; at: number; items: BalancesResponse[] } | undefined
> => {
  try {
    const session = await chrome.storage.session.get([KEY, 'passwordKey']);
    // A locked wallet never shows balances, and doesn't keep them in memory
    // either: drop the snapshot the moment we see the wallet is locked.
    if (!session['passwordKey']) {
      await chrome.storage.session.remove(KEY);
      return undefined;
    }
    const stored = session[KEY] as StoredSnapshot | undefined;
    if (!stored || stored.owner !== (await ownerKey())) {
      return undefined;
    }
    return {
      account: stored.account,
      at: stored.at,
      items: stored.items.map(json => BalancesResponse.fromJsonString(json)),
    };
  } catch {
    return undefined;
  }
};

/** Drop the snapshot (wallet switch / lock), so stale numbers never linger. */
export const clearBalancesSnapshot = async (): Promise<void> => {
  try {
    await chrome.storage.session.remove(KEY);
  } catch {
    // nothing to clear
  }
};
