import { useQuery } from '@tanstack/react-query';
import { sample } from 'lodash';
import { createClient, Transport } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { TendermintProxyService } from '@penumbra-zone/protobuf';
import { useStore } from '../state';
import { networkSelector } from '../state/network';
import { DEFAULT_GRPC } from '../routes/page/onboarding/constants';

// Utility function to fetch the block height by querying RPC endpoints.
// Always tries DEFAULT_GRPC first (even if not in registry), then falls back to registry endpoints.
// Implements a timeout mechanism at the request level to avoid hanging from stalled requests.
export const fetchBlockHeightWithFallback = async (
  endpoints: string[],
  transport?: Transport, // Deps injection mostly for unit tests
  triedDefault = false, // Track if we've tried the default
): Promise<{ blockHeight: number; rpc: string }> => {
  // Always try DEFAULT_GRPC first, regardless of whether it's in the registry
  if (!triedDefault) {
    try {
      const blockHeight = await fetchBlockHeightWithTimeout(DEFAULT_GRPC, transport);
      return { blockHeight, rpc: DEFAULT_GRPC };
    } catch {
      // Default failed, fall through to registry endpoints
      return fetchBlockHeightWithFallback(endpoints, transport, true);
    }
  }

  if (endpoints.length === 0) {
    throw new Error('All RPC endpoints failed to fetch the block height.');
  }

  // Randomly sample an RPC endpoint from the remaining registry endpoints
  const selectedGrpc = sample(endpoints);
  if (!selectedGrpc) {
    throw new Error('No RPC endpoints found.');
  }

  try {
    const blockHeight = await fetchBlockHeightWithTimeout(selectedGrpc, transport);
    return { blockHeight, rpc: selectedGrpc };
  } catch {
    // Remove the current endpoint from the list and retry with remaining endpoints
    const remainingEndpoints = endpoints.filter(endpoint => endpoint !== selectedGrpc);
    return fetchBlockHeightWithFallback(remainingEndpoints, transport, true);
  }
};

// Fetch the block height from a specific RPC endpoint with a request-level timeout that supersedes
// the channel transport-level timeout to prevent hanging requests.
export const fetchBlockHeightWithTimeout = async (
  grpcEndpoint: string,
  transport = createGrpcWebTransport({ baseUrl: grpcEndpoint }),
  timeoutMs = 3000,
): Promise<number> => {
  const tendermintClient = createClient(TendermintProxyService, transport);

  const result = await tendermintClient.getStatus({}, { signal: AbortSignal.timeout(timeoutMs) });
  if (!result.syncInfo) {
    throw new Error('No syncInfo in getStatus result');
  }
  return Number(result.syncInfo.latestBlockHeight);
};

// Fetch the block height from a specific RPC endpoint.
export const fetchBlockHeight = async (grpcEndpoint: string): Promise<number> => {
  const tendermintClient = createClient(
    TendermintProxyService,
    createGrpcWebTransport({ baseUrl: grpcEndpoint }),
  );

  const result = await tendermintClient.getStatus({});
  if (!result.syncInfo) {
    throw new Error('No syncInfo in getStatus result');
  }
  return Number(result.syncInfo.latestBlockHeight);
};

export const useLatestBlockHeight = () => {
  const { grpcEndpoint } = useStore(networkSelector);

  return useQuery({
    queryKey: ['latestBlockHeight'],
    queryFn: async () => {
      if (!grpcEndpoint) {
        return;
      }
      return await fetchBlockHeight(grpcEndpoint);
    },
    enabled: Boolean(grpcEndpoint),
  });
};
