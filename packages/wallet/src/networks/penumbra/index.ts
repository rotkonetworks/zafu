/**
 * Penumbra network module
 *
 * Zigner cold wallet integration for Penumbra.
 * Supports dynamic schema updates via QR codes.
 */

// types
export {
  SUBSTRATE_COMPAT,
  CHAIN_ID_PENUMBRA,
  QR_TYPE,
  type PenumbraFvkExport,
  type PenumbraWalletImport,
  type PenumbraSignRequest,
  type PenumbraSignatureResponse,
  type ParsedAction,
  type TransactionSummary,
} from './types';

// schema
export {
  SCHEMA_VERSION,
  createDefaultSchema,
  encodeSchemaUpdateQR,
  encodeSchemaDigestQR,
  encodeRegistryDigestQR,
  bytesToHex,
  type FieldType,
  type FieldDefinition,
  type ActionDefinition,
  type PenumbraActionSchema,
  type SchemaDigest,
  type RegistryDigest,
} from './schema';

// zigner integration
export {
  // FVK import
  parsePenumbraFvkQR,
  createPenumbraWalletImport,
  isPenumbraFvkQR,
  // sign request
  encodePenumbraSignRequest,
  buildSignRequestQR,
  // signature response
  parsePenumbraSignatureResponse,
  isPenumbraSignatureQR,
  // detection
  isPenumbraQR,
  getPenumbraQRType,
} from './zigner';
