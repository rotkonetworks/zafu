/**
 * Multi-network wallet exports
 */

// Common types and utilities
export * from './common/types';
export * from './common/qr';

// Network adapter interface and lazy loading
export {
  type NetworkAdapter,
  type NetworkBalance,
  type NetworkTransaction,
  type SendParams,
  loadNetworkAdapter,
  getNetworkAdapter,
  unloadNetworkAdapter,
  getLoadedAdapters,
  isAdapterLoaded,
} from './adapter';

// Zcash - fixed ZIP-244 format, no schema updates
export {
  // constants
  CHAIN_ID as ZCASH_CHAIN_ID,
  QR_TYPE as ZCASH_QR_TYPE,
  ZCASH_NETWORKS,

  // FVK import
  parseZcashFvkQR,
  createZcashWalletImport,
  isZcashFvkQR,

  // sign request
  encodeZcashSignRequest,

  // signature response
  parseZcashSignatureResponse,
  isZcashSignatureQR,

  // detection
  detectQRNetwork,
  detectQRType,

  // types
  type ZcashFvkExportData,
  type ZcashWalletImport,
  type ZcashSignRequest,
  type ZcashSignatureResponse,
  type ZcashSendParams,
  type SpendableNote,
  type UnsignedZcashTx,
  type SignedZcashTx,
  type ZcashWalletState,
  type ZcashNetworkConfig,
} from './zcash';

// Penumbra - with dynamic schema updates
export {
  // constants
  CHAIN_ID_PENUMBRA,
  QR_TYPE as PENUMBRA_QR_TYPE,
  SCHEMA_VERSION as PENUMBRA_SCHEMA_VERSION,

  // schema
  createDefaultSchema as createPenumbraDefaultSchema,
  encodeSchemaUpdateQR as encodePenumbraSchemaUpdateQR,
  encodeSchemaDigestQR as encodePenumbraSchemaDigestQR,
  encodeRegistryDigestQR as encodePenumbraRegistryDigestQR,

  // FVK import
  parsePenumbraFvkQR,
  createPenumbraWalletImport,
  isPenumbraFvkQR,

  // sign request
  encodePenumbraSignRequest,
  buildSignRequestQR as buildPenumbraSignRequestQR,

  // signature response
  parsePenumbraSignatureResponse,
  isPenumbraSignatureQR,

  // detection
  isPenumbraQR,
  getPenumbraQRType,

  // types
  type PenumbraFvkExport,
  type PenumbraWalletImport,
  type PenumbraSignRequest,
  type PenumbraSignatureResponse,
  type ParsedAction as PenumbraParsedAction,
  type TransactionSummary as PenumbraTransactionSummary,
  type FieldType as PenumbraFieldType,
  type FieldDefinition as PenumbraFieldDefinition,
  type ActionDefinition as PenumbraActionDefinition,
  type PenumbraActionSchema,
  type SchemaDigest as PenumbraSchemaDigest,
  type RegistryDigest as PenumbraRegistryDigest,
} from './penumbra';
