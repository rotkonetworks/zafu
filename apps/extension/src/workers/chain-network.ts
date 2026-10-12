import { storeIsMainnet } from '../state/pocket-id';

/**
 * Which zcash network a node says it serves (GetLightdInfo.chainName), held
 * against the wallet's keys. A mainnet wallet synced from a testnet node finds
 * nothing and used to say "up to date": the node is refused instead, before
 * any block is read. lightwalletd and zidecar answer "main", "test" or
 * "regtest"; an empty or unknown name is not held against the node.
 */
export const chainIsMainnet = (chainName: string): boolean | undefined => {
  const name = chainName.trim().toLowerCase();
  if (name === 'main' || name === 'mainnet') {
    return true;
  }
  if (name === 'test' || name === 'testnet' || name === 'regtest') {
    return false;
  }
  return undefined;
};

/** true when the node names a network other than the wallet's */
export const isWrongNetwork = (chainName: string, walletMainnet: boolean): boolean => {
  const node = chainIsMainnet(chainName);
  return node !== undefined && node !== walletMainnet;
};

/** a watch-only wallet's network is in its viewing key; a seed wallet's in its store id */
export const walletIsMainnet = (ufvk: string | undefined, storeId: string): boolean =>
  ufvk ? !ufvk.startsWith('uviewtest') : storeIsMainnet(storeId);

/** the unit a store's amounts read in: testnet coins are TAZ, never ZEC */
export const unitOf = (storeId: string): 'ZEC' | 'TAZ' => (storeIsMainnet(storeId) ? 'ZEC' : 'TAZ');
