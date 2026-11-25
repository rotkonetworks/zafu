/**
 * The penumbra chain in use, read from storage: the entry (mainnet or its
 * testnet) and the chain id its node last said.
 */

import { AppParameters } from '@penumbra-zone/protobuf/penumbra/core/app/v1/app_pb';
import { AppService } from '@penumbra-zone/protobuf';
import { createClient } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { localExtStorage } from '@repo/storage-chrome/local';
import { PENUMBRA_CHAINS, penumbraNetworkOf, type PenumbraNetwork } from './chain';

const chainIdOf = (json: string | undefined): string | undefined => {
  try {
    return (json && AppParameters.fromJsonString(json).chainId) || undefined;
  } catch {
    return undefined;
  }
};

export interface PenumbraChainNow {
  network: PenumbraNetwork;
  /** what the entry's node last said; undefined before it has said anything */
  stored?: string;
  /** stored, else mainnet's id on mainnet; a testnet no node has named has none */
  chainId?: string;
}

/** the entry in use, or the one named */
export const readPenumbraChain = async (only?: PenumbraNetwork): Promise<PenumbraChainNow> => {
  const network = only ?? penumbraNetworkOf(await localExtStorage.get('enabledNetworks'));
  const stored = chainIdOf(await localExtStorage.get(PENUMBRA_CHAINS[network].params));
  return { network, stored, chainId: stored ?? PENUMBRA_CHAINS[network].fallback };
};

/** the chain a node says it serves ('' when it names none) */
export const chainIdAt = async (baseUrl: string, timeoutMs = 10_000): Promise<string> =>
  (
    await createClient(AppService, createGrpcWebTransport({ baseUrl })).appParameters(
      {},
      { timeoutMs },
    )
  ).appParameters?.chainId ?? '';
