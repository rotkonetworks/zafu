/**
 * zigner signing state slice
 *
 * manages the qr-based signing flow with zigner device:
 * 1. build transaction -> show sign request qr
 * 2. user scans with zigner, approves, shows signature qr
 * 3. scan signature qr -> broadcast transaction
 *
 * ========================================================================
 * DESIGN: ZID signing via zigner
 * ========================================================================
 *
 * current flow is transaction-only (zcash/penumbra spend authorization).
 * ZID adds a new category: identity signing (challenge-response auth).
 *
 * ZID signing flow (new):
 *   1. zafu generates challenge + derivation params -> ur:zid-challenge QR
 *   2. zigner scans, derives the ZID key from its local mnemonic, signs
 *   3. zigner displays ur:zid-response QR (signature + pubkey)
 *   4. zafu scans, verifies signature matches expected ZID
 *
 * this reuses the same scanning infrastructure (camera, QR encode/decode)
 * but the state machine is simpler than transaction signing:
 *   - no "building" step (challenge is instant to generate)
 *   - no "broadcasting" step (verification is local)
 *   - result is boolean (verified / not verified), not a tx hash
 *
 * new signing step type needed: 'zid_challenge' | 'zid_scanning' | 'zid_verified'
 * these could be added to the existing SigningStep union or managed in a
 * separate ZidVerifySlice to keep concerns clean.
 *
 * recommendation: separate slice (zid-verify.ts) since the state shape
 * differs significantly - no transaction, no broadcast, different result.
 * the QR scanning UI components can be shared.
 *
 * FROST + ZID on zigner:
 *   when zigner participates in FROST DKG via QR relay, its ZID pubkey
 *   serves as the participant identifier. the DKG messages already include
 *   participant IDs - for zigner, this should be the cross-site ZID for
 *   the active identity (not a random ID). this makes the FROST key share
 *   permanently bound to a verifiable identity rather than an ephemeral
 *   random value.
 *
 *   the FROST flow on zigner is:
 *   1. zafu shows DKG round 1 as QR (includes other participants' broadcasts)
 *   2. zigner computes its round 1 commitment, shows QR response
 *   3. zafu relays to network, collects round 2, shows to zigner
 *   4. zigner computes round 2, shows QR response
 *   5. repeat for round 3 / finalization
 *   each QR exchange is a separate scan cycle. slow but air-gap-safe.
 *
 * ========================================================================
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
