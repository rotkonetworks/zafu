/**
 * skip go api types
 * minimal subset for ibc routing between cosmos chains
 */

export interface SkipChain {
  chainId: string;
  chainName: string;
  chainType: 'cosmos' | 'evm' | 'svm';
  pfmEnabled: boolean;
  cosmosModuleSupport: {
    authz: boolean;
    feegrant: boolean;
  };
  bech32Prefix?: string;
  logoUri?: string;
}

export interface SkipAsset {
  denom: string;
  chainId: string;
  originDenom: string;
  originChainId: string;
  decimals?: number;
  symbol?: string;
  name?: string;
  logoUri?: string;
  coingeckoId?: string;
  recommendedSymbol?: string;
}

export interface RouteRequest {
  sourceAssetDenom: string;
  sourceAssetChainId: string;
  destAssetDenom: string;
  destAssetChainId: string;
  amountIn: string;
  amountOut?: string;
  allowMultiTx?: boolean;
  allowUnsafe?: boolean;
  bridges?: string[];
  swapVenues?: string[];
  cumulativeAffiliateFeeBps?: string;
}

export interface RouteOperation {
  transfer?: TransferOperation;
  swap?: SwapOperation;
}

export interface TransferOperation {
  port: string;
  channel: string;
  chainId: string;
  pfmEnabled: boolean;
  destDenom: string;
  supportsMemo: boolean;
  bridgeId?: string;
  smartRelay?: boolean;
}

export interface SwapOperation {
  swapIn: {
    swapVenue: { name: string; chainId: string };
    swapOperations: Array<{
      pool: string;
      denomIn: string;
      denomOut: string;
    }>;
  };
  estimatedAffiliateFee?: string;
}

export interface RouteResponse {
  sourceAssetDenom: string;
  sourceAssetChainId: string;
  destAssetDenom: string;
  destAssetChainId: string;
  amountIn: string;
  amountOut: string;
  operations: RouteOperation[];
  chainIds: string[];
  requiredChainAddresses: string[];
  doesSwap: boolean;
  estimatedAmountOut?: string;
  swapVenue?: { name: string; chainId: string };
  txsRequired: number;
  usdAmountIn?: string;
  usdAmountOut?: string;
  swapPriceImpactPercent?: string;
  estimatedFees: Array<{
    feeType: string;
    bridgeId?: string;
    amount: string;
    usdAmount?: string;
    originAsset: SkipAsset;
    chainId: string;
    txIndex: number;
  }>;
  warning?: {
    type: string;
    message: string;
  };
}

export interface MessagesRequest {
  sourceAssetDenom: string;
  sourceAssetChainId: string;
  destAssetDenom: string;
  destAssetChainId: string;
  amountIn: string;
  amountOut: string;
  addressList: string[];
  operations: RouteOperation[];
  estimatedAmountOut?: string;
  slippageTolerancePercent?: string;
  timeoutSeconds?: string;
  postRouteHandler?: {
    wasmMsg?: {
      contractAddress: string;
      msg: string;
    };
  };
}

export interface CosmosTxMessage {
  chainId: string;
  path: string;
  msg: string; // base64 encoded protobuf
  msgTypeUrl: string;
}

export interface CosmosTransaction {
  chainId: string;
  path: string;
  msgs: CosmosTxMessage[];
  signerAddress: string;
}

export interface MessagesResponse {
  msgs: Array<{
    multiChainMsg?: {
      chainId: string;
      path: string;
      msg: string;
      msgTypeUrl: string;
    };
    evmTx?: unknown;
    svmTx?: unknown;
  }>;
  txs: CosmosTransaction[];
}

export interface TransactionStatusRequest {
  chainId: string;
  txHash: string;
}

export interface TransferState {
  state:
    | 'TRANSFER_UNKNOWN'
    | 'TRANSFER_PENDING'
    | 'TRANSFER_RECEIVED'
    | 'TRANSFER_SUCCESS'
    | 'TRANSFER_FAILURE';
}

export interface TransactionStatusResponse {
  status: 'STATE_UNKNOWN' | 'STATE_SUBMITTED' | 'STATE_PENDING' | 'STATE_COMPLETED' | 'STATE_FAILED';
  transferSequence: Array<{
    ibcTransfer?: {
      fromChainId: string;
      toChainId: string;
      state: TransferState['state'];
      packetTxs: {
        sendTx?: { chainId: string; txHash: string };
        receiveTx?: { chainId: string; txHash: string };
        acknowledgeTx?: { chainId: string; txHash: string };
        timeoutTx?: { chainId: string; txHash: string };
      };
      srcChainId: string;
      dstChainId: string;
    };
    axelarTransfer?: unknown;
    cctpTransfer?: unknown;
    hyperlaneTransfer?: unknown;
    opInitTransfer?: unknown;
  }>;
  nextBlockingTransfer?: {
    transferSequenceIndex: number;
  };
  transferAssetRelease?: {
    chainId: string;
    denom: string;
    released: boolean;
  };
  error?: {
    code: number;
    message: string;
  };
  state:
    | 'STATE_UNKNOWN'
    | 'STATE_SUBMITTED'
    | 'STATE_PENDING'
    | 'STATE_COMPLETED_SUCCESS'
    | 'STATE_COMPLETED_ERROR'
    | 'STATE_ABANDONED'
    | 'STATE_PENDING_ERROR';
}

export interface SubmitTransactionRequest {
  chainId: string;
  tx: string; // base64 encoded signed tx
}

export interface SubmitTransactionResponse {
  txHash: string;
}

export interface TrackTransactionRequest {
  chainId: string;
  txHash: string;
}

export interface TrackTransactionResponse {
  txHash: string;
}
