/**
 * ledger-session - connected Ledger device session
 *
 * Holds the session established by the connect/pair step (sessionId +
 * appVersion) so a send can reuse an already-connected device instead of
 * reconnecting per-send. WebHID sessions are process-lived, not persisted:
 * this slice is in-memory only, matching frost-session's transient shape.
 *
 * The stored value mirrors `LedgerSession` in signing/ledger-signer.ts, which
 * is what `ledgerSignerFor` consumes. This slice is intentionally UNWIRED into
 * the send flow - a connect step calls `setSession`, the send flow reads via
 * `ledgerSessionSelector`, and lock/disconnect calls `clearSession`.
 */

import type { AllSlices, SliceCreator } from '.';
import type { LedgerSession } from '../signing/ledger-signer';

export interface LedgerSessionSlice {
  /** the connected Ledger session, or null when no device is paired */
  session: LedgerSession | null;

  /** store the session from a connect/pair step */
  setSession: (session: LedgerSession) => void;
  /** clear the stored session (disconnect / lock) */
  clearSession: () => void;
}

export const createLedgerSessionSlice: SliceCreator<LedgerSessionSlice> = set => ({
  session: null,

  setSession: session => {
    set(state => {
      state.ledgerSession.session = session;
    });
  },

  clearSession: () => {
    set(state => {
      state.ledgerSession.session = null;
    });
  },
});

// ============================================================================
// selectors
// ============================================================================

export const ledgerSessionSelector = (state: AllSlices) => state.ledgerSession;
