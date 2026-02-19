/**
 * cosmos signing hook
 *
 * provides signing functionality for cosmos chains
 * gets mnemonic from keyring and signs/broadcasts transactions
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import { useStore } from '../state';
import { selectSelectedKeyInfo, keyRingSelector } from '../state/keyring';
import {
  signAndBroadcast,
  createSigningClient,
  buildMsgSend,
  buildMsgTransfer,
  calculateFee,
  estimateGas,
} from '@repo/wallet/networks/cosmos/signer';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';

/** send parameters */
export interface CosmosSendParams {
  chainId: CosmosChainId;
  toAddress: string;
  amount: string;
  denom?: string;
  memo?: string;
  accountIndex?: number;
}

/** ibc transfer parameters */
export interface CosmosIbcTransferParams {
  sourceChainId: CosmosChainId;
  destChainId: string;
  sourceChannel: string;
  toAddress: string;
  amount: string;
  denom?: string;
  memo?: string;
  accountIndex?: number;
}

/** hook for cosmos send transactions */
export const useCosmosSend = () => {
  const selectedKeyInfo = useStore(selectSelectedKeyInfo);
  const { getMnemonic } = useStore(keyRingSelector);

  return useMutation({
    mutationFn: async (params: CosmosSendParams) => {
      if (!selectedKeyInfo) {
        throw new Error('no wallet selected');
      }
      if (selectedKeyInfo.type !== 'mnemonic') {
        throw new Error('cosmos signing requires mnemonic wallet');
      }

      const mnemonic = await getMnemonic(selectedKeyInfo.id);

      const config = COSMOS_CHAINS[params.chainId];
      const denom = params.denom ?? config.denom;
      const accountIndex = params.accountIndex ?? 0;

      // derive sender address
      const { address: fromAddress } = await createSigningClient(
        params.chainId,
        mnemonic,
        accountIndex
      ).then(r => ({ address: r.address }));

      // parse amount to smallest unit
      const amountInBase = Math.floor(parseFloat(params.amount) * Math.pow(10, config.decimals));

const messages = [
        buildMsgSend({
          fromAddress,
          toAddress: params.toAddress,
          amount: [{ denom, amount: amountInBase.toString() }],
        }),
      ];

      // estimate gas and calculate fee
      const gas = await estimateGas(params.chainId, fromAddress, messages);
      const fee = calculateFee(params.chainId, gas);

      // sign and broadcast
      const result = await signAndBroadcast(
        params.chainId,
        mnemonic,
        messages,
        fee,
        params.memo ?? '',
        accountIndex
      );

      return {
        txHash: result.transactionHash,
        code: result.code,
        gasUsed: result.gasUsed,
        gasWanted: result.gasWanted,
      };
    },
  });
};

/** hook for IBC transfers */
export const useCosmosIbcTransfer = () => {
  const selectedKeyInfo = useStore(selectSelectedKeyInfo);
  const { getMnemonic } = useStore(keyRingSelector);

  return useMutation({
    mutationFn: async (params: CosmosIbcTransferParams) => {
      if (!selectedKeyInfo) {
        throw new Error('no wallet selected');
      }
      if (selectedKeyInfo.type !== 'mnemonic') {
        throw new Error('cosmos signing requires mnemonic wallet');
      }

      const mnemonic = await getMnemonic(selectedKeyInfo.id);

      const config = COSMOS_CHAINS[params.sourceChainId];
      const denom = params.denom ?? config.denom;
      const accountIndex = params.accountIndex ?? 0;

      // derive sender address
      const { client, address: fromAddress } = await createSigningClient(
        params.sourceChainId,
        mnemonic,
        accountIndex
      );

      // parse amount
      const amountInBase = Math.floor(parseFloat(params.amount) * Math.pow(10, config.decimals));

      // calculate timeout (10 minutes from now in nanoseconds)
      const timeoutTimestamp = BigInt(Date.now() + 10 * 60 * 1000) * 1_000_000n;

const messages = [
        buildMsgTransfer({
          sourcePort: 'transfer',
          sourceChannel: params.sourceChannel,
          token: { denom, amount: amountInBase.toString() },
          sender: fromAddress,
          receiver: params.toAddress,
          timeoutTimestamp,
          memo: params.memo,
        }),
      ];

      try {
        // use 'auto' fee estimation - simulates tx to get correct gas
        const result = await client.signAndBroadcast(fromAddress, messages, 'auto', params.memo ?? '');

        return {
          txHash: result.transactionHash,
          code: result.code,
          gasUsed: result.gasUsed,
          gasWanted: result.gasWanted,
        };
      } finally {
        client.disconnect();
      }
    },
  });
};

/** hook to get cosmos address for a chain */
export const useCosmosAddress = (chainId: CosmosChainId, accountIndex = 0) => {
  const selectedKeyInfo = useStore(selectSelectedKeyInfo);
  const { getMnemonic } = useStore(keyRingSelector);

  return useQuery({
    queryKey: ['cosmosAddress', chainId, selectedKeyInfo?.id, accountIndex],
    queryFn: async () => {
      if (!selectedKeyInfo) {
        throw new Error('no wallet selected');
      }
      if (selectedKeyInfo.type !== 'mnemonic') {
        return null; // watch-only wallets don't have cosmos addresses
      }

      const mnemonic = await getMnemonic(selectedKeyInfo.id);
      const { address } = await createSigningClient(chainId, mnemonic, accountIndex);
      return address;
    },
    enabled: !!selectedKeyInfo && selectedKeyInfo.type === 'mnemonic',
    staleTime: Infinity, // address won't change
  });
};
