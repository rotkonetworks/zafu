/** shielded first; for transparent, which network. Receive and send pick both in their headers. */

import { getCosmosChain, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';

export type Privacy = 'shielded' | 'transparent';

/** networks to offer, the ones being wound down last */
export const orderTransparentChains = (chains: readonly CosmosChainId[]): CosmosChainId[] =>
  [...chains].sort(
    (a, b) => Number(!!getCosmosChain(a).deprecation) - Number(!!getCosmosChain(b).deprecation),
  );
