/**
 * HD addresses on a transparent chain (Injective, Noble, ...), bitcoin-wallet
 * style: every receive takes the next unused index and an address is never
 * shown twice. The indices ever shown, and the ones that ever held funds, are
 * remembered per chain and vault (numbers only - no addresses on disk) and
 * scanned, so money sent to any address we ever handed out stays visible.
 *
 * The index counter is shared with dapp burners (zafu_get_fresh_chain_address),
 * so the two never hand out the same index.
 */

import { nextHdIndex } from '@repo/storage-chrome/cosmos-chain-counters';
import type { CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { conduitFor } from '@repo/wallet/networks/transparent/conduit';

export const MAX_SHOWN_REMEMBERED = 1000;

/** hard cap on how many recent indices one poll derives + queries */
export const MAX_RECENT_SCAN = 20;

/**
 * Low indices always scanned. Before the counter model, deposit addresses were
 * picked as "first empty in 0..8", so funds can sit anywhere in that range.
 */
export const LEGACY_SCAN_GAP = 8;

// `injective...` spellings predate this module; keep them so remembered
// indices carry over.
export const shownIndicesKey = (chainId: CosmosChainId, keyId: string): string =>
  `${chainId}ShownIndices:${keyId}`;
export const fundedIndicesKey = (chainId: CosmosChainId, keyId: string): string =>
  `${chainId}FundedIndices:${keyId}`;

async function readIndices(key: string): Promise<number[]> {
  const stored = (await chrome.storage.local.get(key))[key];
  return Array.isArray(stored) ? stored.filter((i): i is number => Number.isSafeInteger(i)) : [];
}

export const readShownIndices = (chainId: CosmosChainId, keyId: string) =>
  readIndices(shownIndicesKey(chainId, keyId));
export const readFundedIndices = (chainId: CosmosChainId, keyId: string) =>
  readIndices(fundedIndicesKey(chainId, keyId));

/** add `indices` to a remembered list; returns the updated list */
async function remember(key: string, indices: readonly number[], cap?: number): Promise<number[]> {
  const prev = await readIndices(key);
  const add = indices.filter(i => !prev.includes(i));
  if (add.length === 0) {
    return prev;
  }
  const merged = [...prev, ...add];
  const next = cap ? merged.slice(-cap) : merged.sort((a, b) => a - b);
  await chrome.storage.local.set({ [key]: next });
  return next;
}

export const rememberShownIndex = (chainId: CosmosChainId, keyId: string, index: number) =>
  remember(shownIndicesKey(chainId, keyId), [index], MAX_SHOWN_REMEMBERED);
export const rememberFundedIndices = (
  chainId: CosmosChainId,
  keyId: string,
  indices: readonly number[],
) => remember(fundedIndicesKey(chainId, keyId), indices);

/**
 * A fresh address on `chainId`: the next HD index, derived by the chain's
 * conduit (so Injective stays on coin type 60), remembered as shown. Takes the
 * mnemonic first so a locked wallet never burns an index nobody sees.
 */
export async function allocateTransparentAddress(
  chainId: CosmosChainId,
  keyId: string,
  mnemonic: string,
): Promise<{ index: number; address: string }> {
  const index = await nextHdIndex(chainId);
  const address = await conduitFor(chainId).deriveAddress(mnemonic, index);
  await rememberShownIndex(chainId, keyId, index);
  return { index, address };
}

/**
 * The indices one poll scans: 0..LEGACY_SCAN_GAP, the most recent handed out
 * (up to `cap`), and every index that ever held funds.
 */
export function scanIndices(
  highest: number,
  alwaysScan: readonly number[] = [],
  cap = MAX_RECENT_SCAN,
): number[] {
  const top = Number.isSafeInteger(highest) && highest > 0 ? highest : 0;
  const out = new Set<number>();
  for (let i = 0; i <= LEGACY_SCAN_GAP; i++) {
    out.add(i);
  }
  const size = Math.max(1, Math.floor(cap));
  for (let i = Math.max(0, top - size + 1); i <= top; i++) {
    out.add(i);
  }
  for (const i of alwaysScan) {
    if (Number.isSafeInteger(i) && i >= 0) {
      out.add(i);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** 0xabcd...wxyz / inj1abcd...wxyz */
export function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 8)}...${address.slice(-4)}` : address;
}
