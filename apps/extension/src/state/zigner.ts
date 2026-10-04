/**
 * Zigner cold wallet state management.
 *
 * This module manages:
 * - Camera settings for QR scanning
 * - QR code scanning state during onboarding or wallet addition
 *
 * Zigner's scope is zcash and penumbra only (see AGENTS.md / the
 * components/device-scanner rework) - `processQrData` delegates its actual
 * parsing to the pure, unit-tested `parseConnectCode` in
 * components/device-scanner/parse-connect-code.ts, which is also what the
 * settings/popup device scanner uses directly. This slice exists so
 * onboarding's multi-screen scan flow (import-zigner.tsx) keeps its current
 * shape; `parsedCosmosExport` stays declared for that flow's types but
 * is never populated - any other code reads as not a connect code.
 */

import type { AllSlices, SliceCreator } from '.';
import type { ExtensionStorage } from '@repo/storage-chrome/base';
import type { LocalStorageState } from '@repo/storage-chrome/local';
import {
  createWalletImport,
  type ZignerWalletImport,
  type ZignerFvkExportData,
} from '@repo/wallet/zigner-signer';
import {
  createZcashWalletImport,
  type ZcashWalletImport,
  type ZcashFvkExportData,
} from '@repo/wallet/zcash-zigner';
import { parseZcashAccountsCbor } from '@repo/wallet/ur-parser';
import {
  parseConnectCode,
  type ParsedConnectCode,
} from '../components/device-scanner/parse-connect-code';

// ============================================================================
// Types
// ============================================================================

/**
 * Scan state for Zigner QR code scanning.
 */
export type ZignerScanState = 'idle' | 'scanning' | 'scanned' | 'importing' | 'complete' | 'error';

/** Detected network type from QR code */
export type DetectedNetwork = 'penumbra' | 'zcash' | 'cosmos' | 'unknown';

/** Cosmos accounts import data - no longer produced (zigner scope is zcash + penumbra); kept for onboarding's types */
export interface CosmosImportData {
  publicKey: string;
  xpub?: string;
  accountIndex: number;
  label: string;
  addresses: { chainId: string; address: string; prefix: string }[];
}

/**
 * Combined Zigner state slice including camera settings and scanning state.
 */
export interface ZignerSlice {
  // Camera settings
  /** Whether camera access is enabled for QR scanning */
  cameraEnabled: boolean;
  /** Set camera enabled state */
  setCameraEnabled: (enabled: boolean) => void;

  // Scanning state
  /** Current scan state */
  scanState: ZignerScanState;
  /** Raw QR code hex data after successful scan */
  qrData?: string;
  /** Detected network from QR code */
  detectedNetwork?: DetectedNetwork;
  /** Parsed Penumbra FVK export data from QR code */
  parsedPenumbraExport?: ZignerFvkExportData;
  /** Parsed Zcash FVK export data from QR code */
  parsedZcashExport?: ZcashFvkExportData;
  /** No longer populated - zigner's scope is zcash + penumbra only */
  parsedCosmosExport?: CosmosImportData;
  /** User-provided label for the wallet */
  walletLabel: string;
  /** Error message if something went wrong */
  errorMessage?: string;

  // Scanning actions
  /** Process scanned QR code data (or pasted text) via parseConnectCode. */
  processQrData: (qrData: string) => void;
  /**
   * Process a `zcash-accounts` payload that has already been reassembled from
   * a multi-frame BC-UR scan (caller is expected to be `AnimatedQrScanner`
   * with `urTypeFilter: 'zcash-accounts'`). Useful for Keystone-class cold
   * signers that emit multipart UR.
   */
  processZcashAccountsBytes: (cbor: Uint8Array) => void;
  /** Set the wallet label */
  setWalletLabel: (label: string) => void;
  /** Set scan state */
  setScanState: (state: ZignerScanState) => void;
  /** Set error state with message */
  setError: (message: string) => void;
  /** Clear all scanning state */
  clearZignerState: () => void;
}

// ============================================================================
// Slice Creator
// ============================================================================

function toPenumbraExport(parsed: Extract<ParsedConnectCode, { network: 'penumbra' }>) {
  return {
    accountIndex: parsed.accountIndex,
    label: parsed.label,
    fvkBytes: parsed.fvkBytes,
    walletIdBytes: parsed.walletIdBytes,
    fvkBech32m: parsed.fvkBech32m,
    zidPublicKey: parsed.zidPublicKey,
  } satisfies ZignerFvkExportData;
}

function toZcashExport(parsed: Extract<ParsedConnectCode, { network: 'zcash' }>) {
  return {
    accountIndex: parsed.accountIndex,
    label: parsed.label,
    orchardFvk: parsed.orchardFvk,
    transparentXpub: null,
    mainnet: parsed.mainnet,
    address: null,
    ufvk: parsed.ufvk ?? undefined,
    zidPublicKey: parsed.zidPublicKey,
    coldSignerType: parsed.device,
  } satisfies ZcashFvkExportData;
}

export const createZignerSlice =
  (local: ExtensionStorage<LocalStorageState>): SliceCreator<ZignerSlice> =>
  set => ({
    // Camera settings
    cameraEnabled: false,
    setCameraEnabled: (enabled: boolean) => {
      set(state => {
        state.zigner.cameraEnabled = enabled;
      });
      void local.set('zignerCameraEnabled', enabled);
    },

    // Scanning state
    scanState: 'idle',
    walletLabel: '',
    qrData: undefined,
    detectedNetwork: undefined,
    parsedPenumbraExport: undefined,
    parsedZcashExport: undefined,
    parsedCosmosExport: undefined,
    errorMessage: undefined,

    processQrData: (qrData: string) => {
      const result = parseConnectCode(qrData);
      if (!result.ok) {
        set(state => {
          state.zigner.scanState = 'error';
          state.zigner.errorMessage = result.message;
        });
        return;
      }

      set(state => {
        state.zigner.qrData = qrData.trim();
        state.zigner.detectedNetwork = result.network;
        state.zigner.parsedPenumbraExport =
          result.network === 'penumbra' ? toPenumbraExport(result) : undefined;
        state.zigner.parsedZcashExport =
          result.network === 'zcash' ? toZcashExport(result) : undefined;
        state.zigner.parsedCosmosExport = undefined;
        state.zigner.walletLabel =
          result.label ?? (result.network === 'penumbra' ? 'zigner penumbra' : 'zigner zcash');
        state.zigner.scanState = 'scanned';
        state.zigner.errorMessage = undefined;
      });
    },

    /**
     * Process a `zcash-accounts` CBOR payload reassembled from multi-frame UR.
     *
     * The path differs from `processQrData` because `parseZcashUr` operates
     * on a single UR string, while a multipart UR scan via the wasm fountain
     * decoder produces the inner CBOR directly. We parse it through
     * `parseZcashAccountsCbor` and then build the same `ZcashFvkExportData`
     * shape so downstream onboarding logic doesn't care which path was taken.
     */
    processZcashAccountsBytes: (cbor: Uint8Array) => {
      try {
        const urExport = parseZcashAccountsCbor(cbor);
        // one scanner for any cold signer: there is no "which device" button
        // to declare from any more - the zid_pubkey tell is the only source
        // of truth (see isLikelyKeystoneAccountsExport).
        const device: 'zigner' | 'keystone' = urExport.zidPublicKey ? 'zigner' : 'keystone';
        const exportData: ZcashFvkExportData = {
          accountIndex: urExport.accountIndex,
          label: urExport.label,
          orchardFvk: null,
          transparentXpub: null,
          mainnet: urExport.ufvk.startsWith('uview1'),
          address: null,
          ufvk: urExport.ufvk,
          zidPublicKey: urExport.zidPublicKey,
          coldSignerType: device,
        };
        const defaultLabel =
          urExport.label || (device === 'zigner' ? 'zigner zcash' : 'keystone zcash');
        set(state => {
          state.zigner.qrData = '<multipart-ur:zcash-accounts>'; // sentinel, not a real UR string
          state.zigner.detectedNetwork = 'zcash';
          state.zigner.parsedZcashExport = exportData;
          state.zigner.parsedPenumbraExport = undefined;
          state.zigner.walletLabel = defaultLabel;
          state.zigner.scanState = 'scanned';
          state.zigner.errorMessage = undefined;
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        set(state => {
          state.zigner.scanState = 'error';
          state.zigner.errorMessage = `failed to parse zcash-accounts cbor: ${message}`;
        });
      }
    },

    setWalletLabel: (label: string) => {
      set(state => {
        state.zigner.walletLabel = label;
      });
    },

    setScanState: (scanState: ZignerScanState) => {
      set(state => {
        state.zigner.scanState = scanState;
        if (scanState === 'idle' || scanState === 'scanning') {
          state.zigner.errorMessage = undefined;
        }
      });
    },

    setError: (message: string) => {
      set(state => {
        state.zigner.scanState = 'error';
        state.zigner.errorMessage = message;
      });
    },

    clearZignerState: () => {
      set(state => {
        state.zigner.scanState = 'idle';
        state.zigner.qrData = undefined;
        state.zigner.detectedNetwork = undefined;
        state.zigner.parsedPenumbraExport = undefined;
        state.zigner.parsedZcashExport = undefined;
        state.zigner.parsedCosmosExport = undefined;
        state.zigner.walletLabel = '';
        state.zigner.errorMessage = undefined;
      });
    },
  });

// ============================================================================
// Selectors
// ============================================================================

/**
 * Selector for Zigner camera settings.
 */
export const zignerSettingsSelector = (state: AllSlices) => ({
  cameraEnabled: state.zigner.cameraEnabled,
  setCameraEnabled: state.zigner.setCameraEnabled,
});

/**
 * Selector for Zigner scanning state.
 * Creates protobuf wallet import on demand to avoid immer WritableDraft issues.
 * Supports both Penumbra and Zcash networks.
 */
export const zignerConnectSelector = (state: AllSlices) => {
  const slice = state.zigner;

  // Create wallet import from raw export data based on detected network
  const walletImport: ZignerWalletImport | undefined = slice.parsedPenumbraExport
    ? createWalletImport(slice.parsedPenumbraExport, slice.walletLabel || 'zigner penumbra')
    : undefined;

  const zcashWalletImport: ZcashWalletImport | undefined = slice.parsedZcashExport
    ? createZcashWalletImport(slice.parsedZcashExport, slice.walletLabel || 'zigner zcash')
    : undefined;

  return {
    scanState: slice.scanState,
    qrData: slice.qrData,
    detectedNetwork: slice.detectedNetwork,
    parsedPenumbraExport: slice.parsedPenumbraExport,
    parsedZcashExport: slice.parsedZcashExport,
    parsedCosmosExport: slice.parsedCosmosExport,
    walletLabel: slice.walletLabel,
    errorMessage: slice.errorMessage,
    walletImport,
    zcashWalletImport,
    processQrData: slice.processQrData,
    processZcashAccountsBytes: slice.processZcashAccountsBytes,
    setWalletLabel: slice.setWalletLabel,
    setScanState: slice.setScanState,
    setError: slice.setError,
    clearZignerState: slice.clearZignerState,
  };
};

// Legacy export for backwards compatibility
export type { ZignerSlice as ZignerConnectSlice };
export type { ZcashWalletImport };
