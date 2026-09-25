/**
 * Injective HD indices shown to the user as a receive / withdraw-to address,
 * per vault (index numbers only - no addresses on disk). The Injective screen
 * sweeps every one of them, so funds sent to any address we ever handed out
 * become visible. Shared by the Injective screen and Send's
 * Penumbra -> Injective withdraw.
 */

import { nextHdIndex } from '@repo/storage-chrome/cosmos-chain-counters';
import { deriveInjectiveAddress } from '@repo/wallet/networks/injective/derive';

export const MAX_SHOWN_REMEMBERED = 1000;

export const shownIndicesKey = (keyId: string): string => `injectiveShownIndices:${keyId}`;

/** append `index` to the vault's shown list; returns the updated list */
export async function rememberShownIndex(keyId: string, index: number): Promise<number[]> {
  const key = shownIndicesKey(keyId);
  const prev = ((await chrome.storage.local.get(key))[key] as number[] | undefined) ?? [];
  if (prev.includes(index)) {
    return prev;
  }
  const next = [...prev, index].slice(-MAX_SHOWN_REMEMBERED);
  await chrome.storage.local.set({ [key]: next });
  return next;
}

/**
 * A fresh Injective address: the next HD index (shared counter with dapp
 * burners), derived on the Ethermint path (coin type 60 - never the cosmos
 * 118 path, which yields a different, wrong address), and remembered as
 * shown. Takes the mnemonic first so a locked wallet never burns an index.
 */
export async function allocateInjectiveAddress(
  keyId: string,
  mnemonic: string,
): Promise<{ index: number; address: string }> {
  const index = await nextHdIndex('injective');
  const address = await deriveInjectiveAddress(mnemonic, index);
  await rememberShownIndex(keyId, index);
  return { index, address };
}
