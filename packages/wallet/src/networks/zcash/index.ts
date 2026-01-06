/**
 * Zcash network module
 *
 * Zigner cold wallet integration for Zcash.
 * Uses fixed ZIP-244 transaction format - no schema updates needed.
 */

// types
export {
  type ZcashSendParams,
  type SpendableNote,
  type UnsignedZcashTx,
  type SignedZcashTx,
  type ZcashWalletState,
  type ZcashNetworkConfig,
  ZCASH_NETWORKS,
} from './types';

// zigner integration
export {
  // constants
  SUBSTRATE_COMPAT,
  CHAIN_ID,
  QR_TYPE,
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
} from './zigner';
