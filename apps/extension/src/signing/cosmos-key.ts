/**
 * The selected wallet's own key for a cosmos chain. One copy, for balances and
 * for signing. When the selected wallet has no key for the chain, zafu says so
 * and never reaches for another wallet's key: the funds and the signature must
 * belong to the wallet the user is looking at.
 */

import { deriveChainAddress } from '@repo/wallet/networks/cosmos/signer';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { CAPS, walletKind, type WalletFacts } from './wallet-kind';

export type CosmosKey<K> =
  | { readonly signer: 'hot'; readonly key: K }
  | { readonly signer: 'zigner'; readonly key: K; readonly address: string };

/** the address a zigner exported for `chainId`, or one derived from its prefix */
const zignerAddress = (insensitive: Record<string, unknown>, chainId: CosmosChainId) => {
  // zigner holds coin-118 cosmos keys; nothing it has is valid on an Ethermint chain
  if (COSMOS_CHAINS[chainId].keyAlgo === 'eth_secp256k1') {
    return null;
  }
  const addrs = insensitive['cosmosAddresses'] as
    | { chainId: string; address: string }[]
    | undefined;
  const match = addrs?.find(a => a.chainId === chainId);
  if (match || !addrs?.length) {
    return match?.address ?? null;
  }
  try {
    return deriveChainAddress(addrs[0]!.address, chainId);
  } catch {
    return null;
  }
};

export const cosmosKeyFor = <K extends WalletFacts>(
  key: K | undefined,
  chainId: CosmosChainId,
): CosmosKey<K> | null => {
  if (!key) {
    return null;
  }
  const signer = CAPS[walletKind(key)].cosmos;
  if (signer === 'hot') {
    return { signer, key };
  }
  const address = signer === 'zigner' ? zignerAddress(key.insensitive ?? {}, chainId) : null;
  return address ? { signer: 'zigner', key, address } : null;
};

export const noCosmosKey = (chainId: CosmosChainId) =>
  `this wallet has no key for ${COSMOS_CHAINS[chainId].name.toLowerCase()} · add one or pick a wallet that has it`;
