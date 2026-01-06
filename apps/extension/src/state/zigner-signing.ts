/**
 * zigner signing state slice
 *
 * manages the qr-based signing flow with zigner device:
 * 1. build transaction -> show sign request qr
 * 2. user scans with zigner, approves, shows signature qr
 * 3. scan signature qr -> broadcast transaction
 */

import type { AllSlices, SliceCreator } from '.';
import type { NetworkType } from '@repo/wallet/networks';

// ============================================================================
// types
// ============================================================================

export type SigningStep =
  | 'idle'
  | 'building'
  | 'show_qr'
  | 'scanning'
  | 'broadcasting'
  | 'complete'
  | 'error';

export interface SigningTransaction {
  /** local transaction id */
  id: string;
  /** network type */
  network: NetworkType;
  /** human-readable summary */
  summary: string;
  /** qr hex to display for signing */
  signRequestQr: string;
  /** recipient address */
  recipient: string;
  /** amount (display string) */
  amount: string;
  /** fee (display string) */
  fee: string;
  /** created timestamp */
  createdAt: number;
}

export interface ZignerSigningSlice {
  /** current step in signing flow */
  step: SigningStep;
  /** current transaction being signed */
  transaction: SigningTransaction | null;
  /** scanned signature qr hex */
  signatureQr: string | null;
  /** on-chain tx hash after broadcast */
  txHash: string | null;
  /** error message if failed */
  error: string | null;

  // actions
  /** start a new signing flow */
  startSigning: (tx: SigningTransaction) => void;
  /** set step to show qr */
  showSignRequest: () => void;
  /** set step to scanning */
  startScanning: () => void;
  /** process scanned signature */
  processSignature: (signatureHex: string) => void;
  /** start broadcasting */
  startBroadcast: () => void;
  /** complete with tx hash */
  complete: (txHash: string) => void;
  /** set error */
  setError: (error: string) => void;
  /** reset signing state */
  reset: () => void;
}

// ============================================================================
// slice creator
// ============================================================================

export const createZignerSigningSlice: SliceCreator<ZignerSigningSlice> = (set) => ({
  step: 'idle',
  transaction: null,
  signatureQr: null,
  txHash: null,
  error: null,

  startSigning: (tx) => {
    set((state) => {
      state.zignerSigning.step = 'building';
      state.zignerSigning.transaction = tx;
      state.zignerSigning.signatureQr = null;
      state.zignerSigning.txHash = null;
      state.zignerSigning.error = null;
    });
  },

  showSignRequest: () => {
    set((state) => {
      state.zignerSigning.step = 'show_qr';
    });
  },

  startScanning: () => {
    set((state) => {
      state.zignerSigning.step = 'scanning';
    });
  },

  processSignature: (signatureHex) => {
    set((state) => {
      state.zignerSigning.signatureQr = signatureHex;
      state.zignerSigning.step = 'broadcasting';
    });
  },

  startBroadcast: () => {
    set((state) => {
      state.zignerSigning.step = 'broadcasting';
    });
  },

  complete: (txHash) => {
    set((state) => {
      state.zignerSigning.txHash = txHash;
      state.zignerSigning.step = 'complete';
    });
  },

  setError: (error) => {
    set((state) => {
      state.zignerSigning.error = error;
      state.zignerSigning.step = 'error';
    });
  },

  reset: () => {
    set((state) => {
      state.zignerSigning.step = 'idle';
      state.zignerSigning.transaction = null;
      state.zignerSigning.signatureQr = null;
      state.zignerSigning.txHash = null;
      state.zignerSigning.error = null;
    });
  },
});

// ============================================================================
// selectors
// ============================================================================

export const zignerSigningSelector = (state: AllSlices) => state.zignerSigning;
