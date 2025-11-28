/**
 * Zigner cold wallet state management.
 *
 * This module manages:
 * - Camera settings for QR scanning
 * - QR code scanning state during onboarding or wallet addition
 *
 * Designed to be compatible with the upcoming onboarding restructure
 * (see prax-wallet/prax PR #402) while working standalone until that lands.
 */

import type { AllSlices, SliceCreator } from '.';
import type { ExtensionStorage } from '@repo/storage-chrome/base';
import type { LocalStorageState } from '@repo/storage-chrome/local';
import {
  parseZignerFvkQR,
  createWalletImport,
  isZignerFvkQR,
  type ZignerFvkExportData,
  type ZignerWalletImport,
} from '@repo/wallet/zigner-signer';

// ============================================================================
// Types
// ============================================================================

/**
 * Scan state for Zigner QR code scanning.
 */
export type ZignerScanState = 'idle' | 'scanning' | 'scanned' | 'importing' | 'complete' | 'error';

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
  /** Parsed FVK export data from QR code (raw data, not protobuf) */
  parsedExport?: ZignerFvkExportData;
  /** User-provided label for the wallet */
  walletLabel: string;
  /** Error message if something went wrong */
  errorMessage?: string;

  // Scanning actions
  /**
   * Process scanned QR code data.
   * Validates format and parses the FVK export.
   */
  processQrData: (qrData: string) => void;
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
    parsedExport: undefined,
    errorMessage: undefined,

    processQrData: (qrData: string) => {
      const trimmed = qrData.trim();

      if (!isZignerFvkQR(trimmed)) {
        set(state => {
          state.zigner.scanState = 'error';
          state.zigner.errorMessage = 'Invalid QR code format. Expected Zigner FVK export.';
        });
        return;
      }

      try {
        const exportData = parseZignerFvkQR(trimmed);
        const defaultLabel = exportData.label || 'Zigner Wallet';

        set(state => {
          state.zigner.qrData = trimmed;
          state.zigner.parsedExport = exportData;
          state.zigner.walletLabel = defaultLabel;
          state.zigner.scanState = 'scanned';
          state.zigner.errorMessage = undefined;
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        set(state => {
          state.zigner.scanState = 'error';
          state.zigner.errorMessage = `Failed to parse QR code: ${message}`;
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
        state.zigner.parsedExport = undefined;
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
 */
export const zignerConnectSelector = (state: AllSlices) => {
  const slice = state.zigner;

  // Create wallet import from raw export data if available
  const walletImport: ZignerWalletImport | undefined = slice.parsedExport
    ? createWalletImport(slice.parsedExport, slice.walletLabel || 'Zigner Wallet')
    : undefined;

  return {
    scanState: slice.scanState,
    qrData: slice.qrData,
    parsedExport: slice.parsedExport,
    walletLabel: slice.walletLabel,
    errorMessage: slice.errorMessage,
    walletImport,
    processQrData: slice.processQrData,
    setWalletLabel: slice.setWalletLabel,
    setScanState: slice.setScanState,
    setError: slice.setError,
    clearZignerState: slice.clearZignerState,
  };
};

// Legacy export for backwards compatibility
export type { ZignerSlice as ZignerConnectSlice };
