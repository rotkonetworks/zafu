/**
 * hook for skip go routing between cosmos chains
 * handles route finding, message generation, and status tracking
 */

import { useQuery, useMutation } from '@tanstack/react-query';
import { SkipClient, type RouteRequest, type RouteResponse, type MessagesResponse } from '@penumbra-zone/query/skip/index';

const skipClient = new SkipClient();

export interface UseSkipRouteOptions {
  sourceChainId: string;
  sourceAssetDenom: string;
  destChainId: string;
  destAssetDenom: string;
  amount: string;
  enabled?: boolean;
}

/** fetch route for a transfer */
export const useSkipRoute = (options: UseSkipRouteOptions) => {
  const { sourceChainId, sourceAssetDenom, destChainId, destAssetDenom, amount, enabled = true } = options;

  return useQuery({
    queryKey: ['skipRoute', sourceChainId, sourceAssetDenom, destChainId, destAssetDenom, amount],
    queryFn: async (): Promise<RouteResponse> => {
      if (!amount || amount === '0') {
        throw new Error('amount required');
      }

      const request: RouteRequest = {
        sourceAssetChainId: sourceChainId,
        sourceAssetDenom: sourceAssetDenom,
        destAssetChainId: destChainId,
        destAssetDenom: destAssetDenom,
        amountIn: amount,
        allowMultiTx: false,
        allowUnsafe: false,
      };

      return skipClient.route(request);
    },
    enabled: enabled && !!sourceChainId && !!destChainId && !!amount && amount !== '0',
    staleTime: 30_000, // 30 seconds
    retry: 1,
  });
};

export interface UseSkipMessagesOptions {
  route: RouteResponse | undefined;
  addresses: string[];
  slippagePercent?: string;
}

/** fetch transaction messages for a route */
export const useSkipMessages = (options: UseSkipMessagesOptions) => {
  const { route, addresses, slippagePercent = '1' } = options;

  return useQuery({
    queryKey: ['skipMessages', route?.operations, addresses],
    queryFn: async (): Promise<MessagesResponse> => {
      if (!route) throw new Error('route required');
      if (addresses.length === 0) throw new Error('addresses required');

      return skipClient.messages({
        sourceAssetDenom: route.sourceAssetDenom,
        sourceAssetChainId: route.sourceAssetChainId,
        destAssetDenom: route.destAssetDenom,
        destAssetChainId: route.destAssetChainId,
        amountIn: route.amountIn,
        amountOut: route.amountOut,
        addressList: addresses,
        operations: route.operations,
        slippageTolerancePercent: slippagePercent,
      });
    },
    enabled: !!route && addresses.length > 0,
    staleTime: 30_000,
  });
};

/** track transaction status */
export const useSkipTransactionStatus = (chainId: string | undefined, txHash: string | undefined) => {
  return useQuery({
    queryKey: ['skipTxStatus', chainId, txHash],
    queryFn: async () => {
      if (!chainId || !txHash) throw new Error('chainId and txHash required');
      return skipClient.transactionStatus({ chainId, txHash });
    },
    enabled: !!chainId && !!txHash,
refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 3000;
      // stop polling when completed
      if (
        data.state === 'STATE_COMPLETED_SUCCESS' ||
        data.state === 'STATE_COMPLETED_ERROR' ||
        data.state === 'STATE_ABANDONED'
      ) {
        return false;
      }
      return 3000; // poll every 3 seconds
    },
  });
};

/** mutation to wait for transaction completion */
export const useWaitForSkipTransaction = () => {
  return useMutation({
    mutationFn: async ({
      chainId,
      txHash,
      onStatus,
    }: {
      chainId: string;
      txHash: string;
      onStatus?: (status: Awaited<ReturnType<typeof skipClient.transactionStatus>>) => void;
    }) => {
      return skipClient.waitForTransaction({ chainId, txHash }, { onStatus });
    },
  });
};

/** get list of supported cosmos chains */
export const useSkipChains = () => {
  return useQuery({
    queryKey: ['skipChains'],
    queryFn: () => skipClient.chains({ includeEvm: false, includeSvm: false }),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
};

/** get assets for a chain */
export const useSkipAssets = (chainId: string | undefined) => {
  return useQuery({
    queryKey: ['skipAssets', chainId],
    queryFn: () => {
      if (!chainId) throw new Error('chainId required');
      return skipClient.assets(chainId);
    },
    enabled: !!chainId,
    staleTime: 5 * 60 * 1000,
  });
};
