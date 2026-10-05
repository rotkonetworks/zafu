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

/** a watch-only wallet's network is in its viewing key; a seed wallet here is mainnet */
export const walletIsMainnet = (ufvk?: string): boolean => !ufvk?.startsWith('uviewtest');
