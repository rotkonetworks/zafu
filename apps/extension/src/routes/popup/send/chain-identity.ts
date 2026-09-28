/**
 * Which cosmos chain a send from a network spends on.
 *
 * The send form used to classify the active network through a noble-only
 * allow-list (`COSMOS_CHAIN_IDS = ['noble']`), so every other live IBC
 * subnetwork (cosmoshub, osmosis, injective) fell through to the generic
 * placeholder even though CosmosSend handles them fine. Classify through the
 * canonical registries instead: NETWORKS says whether the network is a live IBC
 * destination, COSMOS_CHAINS says which chain id to key the transfer off. Never
 * cast a network key to a CosmosChainId - the two unions are not the same set.
 */

import { NETWORKS, type NetworkConfig } from '../../../config/networks';
import { chainByChainId, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import type { NetworkType } from '../../../state/keyring';

export function resolveNetworkCosmosChain(network: NetworkType): CosmosChainId | undefined {
  // a stale persisted key can miss the table at runtime, so treat it as a miss
  const config: NetworkConfig | undefined = NETWORKS[network];
  if (!config?.launched || !config.ibcChainId) {
    return undefined;
  }
  return chainByChainId(config.ibcChainId)?.id;
}
