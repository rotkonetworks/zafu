/**
 * Zafu cold wallet state management.
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
import {
  parseZcashFvkQR,
  createZcashWalletImport,
  isZcashFvkQR,
  detectQRNetwork,
  type ZcashFvkExportData,
  type ZcashWalletImport,
} from '@repo/wallet/zcash-zigner';
import {
  isUrString,
  getUrType,
  parsePenumbraUr,
  parseZcashUr,
} from '@repo/wallet/ur-parser';

// ============================================================================
// Types
// ============================================================================

/**
 * Scan state for Zafu QR code scanning.
 */
export type ZafuScanState = 'idle' | 'scanning' | 'scanned' | 'importing' | 'complete' | 'error';

/** Detected network type from QR code */
export type DetectedNetwork = 'penumbra' | 'zcash' | 'polkadot' | 'cosmos' | 'backup' | 'unknown';

/** Polkadot address import data from Zafu QR */
export interface PolkadotImportData {
  /** SS58 encoded address */
  address: string;
  /** Genesis hash (hex with 0x prefix) */
  genesisHash: string;
  /** Label for the wallet */
  label: string;
}

/** Cosmos accounts import data from Zafu QR */
export interface CosmosImportData {
  /** Hex-encoded compressed secp256k1 public key */
  publicKey: string;
  /** Account index */
  accountIndex: number;
  /** Label for the wallet */
  label: string;
  /** Addresses for each chain */
  addresses: { chainId: string; address: string; prefix: string }[];
}

/**
 * Combined Zafu state slice including camera settings and scanning state.
 */
export interface ZafuSlice {
  // Camera settings
  /** Whether camera access is enabled for QR scanning */
  cameraEnabled: boolean;
  /** Set camera enabled state */
  setCameraEnabled: (enabled: boolean) => void;

  // Scanning state
  /** Current scan state */
  scanState: ZafuScanState;
  /** Raw QR code hex data after successful scan */
  qrData?: string;
  /** Detected network from QR code */
  detectedNetwork?: DetectedNetwork;
  /** Parsed Penumbra FVK export data from QR code */
  parsedPenumbraExport?: ZignerFvkExportData;
  /** Parsed Zcash FVK export data from QR code */
  parsedZcashExport?: ZcashFvkExportData;
  /** Parsed Polkadot address data from QR code */
  parsedPolkadotExport?: PolkadotImportData;
  /** Parsed Cosmos accounts data from QR code */
  parsedCosmosExport?: CosmosImportData;
  /** User-provided label for the wallet */
  walletLabel: string;
  /** Error message if something went wrong */
  errorMessage?: string;

  // Scanning actions
  /**
   * Process scanned QR code data.
   * Validates format and parses the FVK export (supports Penumbra and Zcash).
   */
  processQrData: (qrData: string) => void;
  /** Set the wallet label */
  setWalletLabel: (label: string) => void;
  /** Set scan state */
  setScanState: (state: ZafuScanState) => void;
  /** Set error state with message */
  setError: (message: string) => void;
  /** Clear all scanning state */
  clearZafuState: () => void;
}

// ============================================================================
// Slice Creator
// ============================================================================

export const createZafuSlice =
  (local: ExtensionStorage<LocalStorageState>): SliceCreator<ZafuSlice> =>
  set => ({
    // Camera settings
    cameraEnabled: false,
    setCameraEnabled: (enabled: boolean) => {
      set(state => {
        state.zafu.cameraEnabled = enabled;
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
    parsedPolkadotExport: undefined,
    parsedCosmosExport: undefined,
    errorMessage: undefined,

    processQrData: (qrData: string) => {
      const trimmed = qrData.trim();

      // Check for Cosmos accounts JSON format from Zafu
      if (trimmed.startsWith('{') && trimmed.includes('"cosmos-accounts"')) {
        try {
          const parsed = JSON.parse(trimmed) as {
            type: string;
            version: number;
            label: string;
            account_index: number;
            public_key: string;
            addresses: { chain_id: string; address: string; prefix: string }[];
          };

          if (parsed.type === 'cosmos-accounts' && parsed.public_key && parsed.addresses?.length) {
            const cosmosData: CosmosImportData = {
              publicKey: parsed.public_key,
              accountIndex: parsed.account_index ?? 0,
              label: parsed.label || 'zafu cosmos',
              addresses: parsed.addresses.map(a => ({
                chainId: a.chain_id,
                address: a.address,
                prefix: a.prefix,
              })),
            };

            set(state => {
              state.zafu.qrData = trimmed;
              state.zafu.detectedNetwork = 'cosmos';
              state.zafu.parsedCosmosExport = cosmosData;
              state.zafu.parsedPenumbraExport = undefined;
              state.zafu.parsedZcashExport = undefined;
              state.zafu.parsedPolkadotExport = undefined;
              state.zafu.walletLabel = cosmosData.label;
              state.zafu.scanState = 'scanned';
              state.zafu.errorMessage = undefined;
            });
            return;
          }
        } catch {
          // Not valid JSON, fall through to other checks
        }
      }

      // Check for Substrate/Polkadot address format: substrate:address:0xgenesishash
      if (trimmed.startsWith('substrate:')) {
        const parts = trimmed.split(':');
        if (parts.length >= 3) {
          const address = parts[1]!;
          const genesisHash = parts.slice(2).join(':'); // handle case where genesis has colons

          // Validate the format
          if (address && genesisHash && genesisHash.startsWith('0x')) {
            const exportData: PolkadotImportData = {
              address,
              genesisHash,
              label: 'zafu polkadot',
            };

            set(state => {
              state.zafu.qrData = trimmed;
              state.zafu.detectedNetwork = 'polkadot';
              state.zafu.parsedPolkadotExport = exportData;
              state.zafu.parsedPenumbraExport = undefined;
              state.zafu.parsedZcashExport = undefined;
              state.zafu.walletLabel = 'zafu polkadot';
              state.zafu.scanState = 'scanned';
              state.zafu.errorMessage = undefined;
            });
            return;
          }
        }

        // Invalid substrate format
        set(state => {
          state.zafu.scanState = 'error';
          state.zafu.errorMessage = 'invalid substrate qr format. expected: substrate:address:0xgenesishash';
        });
        return;
      }

      // Check for Cosmos address format: cosmos:address:0xgenesishash
      if (trimmed.startsWith('cosmos:')) {
        const parts = trimmed.split(':');
        if (parts.length >= 3) {
          const address = parts[1]!;
          const genesisHash = parts.slice(2).join(':');

          if (address && genesisHash && genesisHash.startsWith('0x')) {
            // Detect chain from address prefix
            const chainId = address.startsWith('osmo') ? 'osmosis'
              : address.startsWith('noble') ? 'noble'
              : address.startsWith('celestia') ? 'celestia'
              : 'cosmos';

            const cosmosData: CosmosImportData = {
              publicKey: '', // not available from address-only QR
              accountIndex: 0,
              label: `zafu ${chainId}`,
              addresses: [{ chainId, address, prefix: address.split('1')[0]! }],
            };

            set(state => {
              state.zafu.qrData = trimmed;
              state.zafu.detectedNetwork = 'cosmos';
              state.zafu.parsedCosmosExport = cosmosData;
              state.zafu.parsedPenumbraExport = undefined;
              state.zafu.parsedZcashExport = undefined;
              state.zafu.parsedPolkadotExport = undefined;
              state.zafu.walletLabel = cosmosData.label;
              state.zafu.scanState = 'scanned';
              state.zafu.errorMessage = undefined;
            });
            return;
          }
        }

        set(state => {
          state.zafu.scanState = 'error';
          state.zafu.errorMessage = 'invalid cosmos qr format. expected: cosmos:address:0xgenesishash';
        });
        return;
      }

      // Check for UR format first (preferred format)
      if (isUrString(trimmed)) {
        const urType = getUrType(trimmed);

        if (urType === 'penumbra-accounts') {
          try {
            const urExport = parsePenumbraUr(trimmed);
            // UR format gives us bech32m FVK string - we need to decode it
            // For now, store the string and let createWalletImport handle conversion
            // The bech32m FVK can be decoded to get ak||nk bytes
            const exportData: ZignerFvkExportData = {
              walletIdBytes: urExport.walletId,
              fvkBytes: new Uint8Array(64), // placeholder - will be decoded from bech32m
              accountIndex: urExport.accountIndex,
              label: urExport.label,
              fvkBech32m: urExport.fvk, // store bech32m for decoding
            };
            const defaultLabel = urExport.label || 'zafu penumbra';

            set(state => {
              state.zafu.qrData = trimmed;
              state.zafu.detectedNetwork = 'penumbra';
              state.zafu.parsedPenumbraExport = exportData;
              state.zafu.parsedZcashExport = undefined;
              state.zafu.walletLabel = defaultLabel;
              state.zafu.scanState = 'scanned';
              state.zafu.errorMessage = undefined;
            });
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            set(state => {
              state.zafu.scanState = 'error';
              state.zafu.errorMessage = `failed to parse penumbra ur: ${message}`;
            });
          }
          return;
        }

        if (urType === 'zcash-accounts') {
          try {
            const urExport = parseZcashUr(trimmed);
            const exportData: ZcashFvkExportData = {
              accountIndex: urExport.accountIndex,
              label: urExport.label,
              orchardFvk: null, // UR format uses UFVK string, not raw FVK bytes
              transparentXpub: null,
              mainnet: urExport.ufvk.startsWith('uview1'), // mainnet starts with uview1, testnet with uviewtest1
              address: null, // not included in UR format
              ufvk: urExport.ufvk, // store the UFVK string
            };
            const defaultLabel = urExport.label || 'zafu zcash';

            set(state => {
              state.zafu.qrData = trimmed;
              state.zafu.detectedNetwork = 'zcash';
              state.zafu.parsedZcashExport = exportData;
              state.zafu.parsedPenumbraExport = undefined;
              state.zafu.walletLabel = defaultLabel;
              state.zafu.scanState = 'scanned';
              state.zafu.errorMessage = undefined;
            });
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            set(state => {
              state.zafu.scanState = 'error';
              state.zafu.errorMessage = `failed to parse zcash ur: ${message}`;
            });
          }
          return;
        }

        // Unknown UR type
        set(state => {
          state.zafu.scanState = 'error';
          state.zafu.errorMessage = `unsupported ur type: ${urType}. expected penumbra-accounts or zcash-accounts`;
        });
        return;
      }

      // Legacy binary format support (for backwards compatibility)
      const network = detectQRNetwork(trimmed);

      if (network === 'penumbra' && isZignerFvkQR(trimmed)) {
        try {
          const exportData = parseZignerFvkQR(trimmed);
          const defaultLabel = exportData.label || 'zafu penumbra';

          set(state => {
            state.zafu.qrData = trimmed;
            state.zafu.detectedNetwork = 'penumbra';
            state.zafu.parsedPenumbraExport = exportData;
            state.zafu.parsedZcashExport = undefined;
            state.zafu.walletLabel = defaultLabel;
            state.zafu.scanState = 'scanned';
            state.zafu.errorMessage = undefined;
          });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          set(state => {
            state.zafu.scanState = 'error';
            state.zafu.errorMessage = `failed to parse penumbra fvk: ${message}`;
          });
        }
      } else if (network === 'zcash' && isZcashFvkQR(trimmed)) {
        try {
          const exportData = parseZcashFvkQR(trimmed);
          const defaultLabel = exportData.label || 'zafu zcash';

          set(state => {
            state.zafu.qrData = trimmed;
            state.zafu.detectedNetwork = 'zcash';
            state.zafu.parsedZcashExport = exportData;
            state.zafu.parsedPenumbraExport = undefined;
            state.zafu.walletLabel = defaultLabel;
            state.zafu.scanState = 'scanned';
            state.zafu.errorMessage = undefined;
          });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          set(state => {
            state.zafu.scanState = 'error';
            state.zafu.errorMessage = `failed to parse zcash fvk: ${message}`;
          });
        }
      } else {
        // Build detailed error message
        const preview = trimmed.slice(0, 24);
        const len = trimmed.length;
        let hint = '';

        if (len < 6) {
          hint = 'qr data too short';
        } else if (/^[0-9a-fA-F]+$/.test(trimmed)) {
          // It's hex but not recognized format
          const byte0 = trimmed.slice(0, 2);
          const byte1 = trimmed.slice(2, 4);
          const byte2 = trimmed.slice(4, 6);
          if (byte0 !== '53') {
            hint = `expected 0x53, got 0x${byte0}`;
          } else if (byte1 !== '03' && byte1 !== '04') {
            hint = `unknown chain 0x${byte1} (penumbra=03, zcash=04)`;
          } else if (byte2 !== '01') {
            hint = `unknown op type 0x${byte2} (fvk export=01)`;
          } else {
            hint = `network=${network}, format check failed`;
          }
        } else {
          hint = 'expected ur:penumbra-accounts or ur:zcash-accounts format';
        }

        set(state => {
          state.zafu.scanState = 'error';
          state.zafu.errorMessage = `invalid qr: ${hint}. got: ${preview}...`;
        });
      }
    },

    setWalletLabel: (label: string) => {
      set(state => {
        state.zafu.walletLabel = label;
      });
    },

    setScanState: (scanState: ZafuScanState) => {
      set(state => {
        state.zafu.scanState = scanState;
        if (scanState === 'idle' || scanState === 'scanning') {
          state.zafu.errorMessage = undefined;
        }
      });
    },

    setError: (message: string) => {
      set(state => {
        state.zafu.scanState = 'error';
        state.zafu.errorMessage = message;
      });
    },

    clearZafuState: () => {
      set(state => {
        state.zafu.scanState = 'idle';
        state.zafu.qrData = undefined;
        state.zafu.detectedNetwork = undefined;
        state.zafu.parsedPenumbraExport = undefined;
        state.zafu.parsedZcashExport = undefined;
        state.zafu.parsedPolkadotExport = undefined;
        state.zafu.parsedCosmosExport = undefined;
        state.zafu.walletLabel = '';
        state.zafu.errorMessage = undefined;
      });
    },
  });

// ============================================================================
// Selectors
// ============================================================================

/**
 * Selector for Zafu camera settings.
 */
export const zafuSettingsSelector = (state: AllSlices) => ({
  cameraEnabled: state.zafu.cameraEnabled,
  setCameraEnabled: state.zafu.setCameraEnabled,
});

/**
 * Selector for Zafu scanning state.
 * Creates protobuf wallet import on demand to avoid immer WritableDraft issues.
 * Supports both Penumbra and Zcash networks.
 */
export const zafuConnectSelector = (state: AllSlices) => {
  const slice = state.zafu;

  // Create wallet import from raw export data based on detected network
  const walletImport: ZignerWalletImport | undefined = slice.parsedPenumbraExport
    ? createWalletImport(slice.parsedPenumbraExport, slice.walletLabel || 'zafu penumbra')
    : undefined;

  const zcashWalletImport: ZcashWalletImport | undefined = slice.parsedZcashExport
    ? createZcashWalletImport(slice.parsedZcashExport, slice.walletLabel || 'zafu zcash')
    : undefined;

  return {
    scanState: slice.scanState,
    qrData: slice.qrData,
    detectedNetwork: slice.detectedNetwork,
    parsedPenumbraExport: slice.parsedPenumbraExport,
    parsedZcashExport: slice.parsedZcashExport,
    parsedPolkadotExport: slice.parsedPolkadotExport,
    parsedCosmosExport: slice.parsedCosmosExport,
    walletLabel: slice.walletLabel,
    errorMessage: slice.errorMessage,
    walletImport,
    zcashWalletImport,
    processQrData: slice.processQrData,
    setWalletLabel: slice.setWalletLabel,
    setScanState: slice.setScanState,
    setError: slice.setError,
    clearZafuState: slice.clearZafuState,
  };
};

// Legacy export for backwards compatibility
export type { ZafuSlice as ZafuConnectSlice };
export type { ZcashWalletImport };
