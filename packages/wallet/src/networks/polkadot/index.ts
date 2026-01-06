/**
 * polkadot network module
 *
 * light client only - no rpc option.
 * uses smoldot for trustless p2p access.
 * merkleized metadata for compact transaction proofs.
 */

export {
  // user-facing
  POLKADOT_NETWORKS,
  getDefaultChain,
  getRelayChain,
  getChainsForNetwork,
  type PolkadotNetwork,
  type NetworkConfig,

  // internal
  PolkadotLightClient,
  getLightClient,
  disconnectAll,
  CHAIN_INFO,
  getParentNetwork,
  type SupportedChain,
  type RelayChain,
  type SystemParachain,
  type EcosystemParachain,
  type ChainInfo,
  type ConnectionState,
  type LightClientState,
} from './light-client';

export {
  buildSignRequestQr,
  parseSignatureQr,
  buildTransferTx,
  broadcastTx,
  isValidSs58,
  formatBalance,
  parseAmount,
  type PolkadotTxType,
  type UnsignedPolkadotTx,
  type SignedPolkadotTx,
} from './zigner';

export {
  generateExtrinsicProof,
  generateMetadataDigest,
  clearMetadataCache,
  UOS_PAYLOAD_CODE,
  UOS_CRYPTO_CODE,
} from './metadata-proof';
