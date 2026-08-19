/**
 * transaction signing security levels
 *
 * controls WHEN the per-transaction password gate is shown. it never changes
 * the cryptography: while the wallet is unlocked the session `passwordKey`
 * already authorizes signing (see state/keyring/crypto-ops.ts `requireKey`).
 * the per-tx password is a SECOND confirmation gate, not the signing key. these
 * levels only decide whether that second gate appears.
 *
 *  - foilhat:     password gate on EVERY transaction + a 3s approve delay.
 *  - grace:       password once, then skipped for a fixed 15-minute window;
 *                 no approve delay. window does not slide and never outlives
 *                 the unlock (cleared whenever `passwordKey` is cleared).
 *  - unlock-only: no per-tx gate at all; signing relies on the app being
 *                 unlocked + auto-lock. no approve delay.
 *
 * pure module - no chrome/browser imports - so the decision logic is unit
 * testable (mirrors perf/rayon-isolation.ts).
 */

export type TxSigningSecurity = 'foilhat' | 'grace' | 'unlock-only';

/** default level: password once, then a 15-minute grace window. */
export const DEFAULT_TX_SIGNING_SECURITY: TxSigningSecurity = 'grace';

/** grace window length in milliseconds (15 minutes). */
export const SIGN_GRACE_MS = 15 * 60 * 1000;

/**
 * Decide whether the per-transaction password gate must be shown.
 *
 * @param level current security level
 * @param now epoch ms (caller passes Date.now() in app runtime code)
 * @param signGraceUntil epoch ms the grace window is valid until, or undefined
 *   when no window is active
 * @returns true if the password gate should block approval; false to sign
 *   directly via the session key path
 */
export function shouldPromptPassword(
  level: TxSigningSecurity,
  now: number,
  signGraceUntil?: number,
): boolean {
  switch (level) {
    case 'foilhat':
      return true;
    case 'unlock-only':
      return false;
    case 'grace':
      // prompt only when there is no live grace window
      return signGraceUntil === undefined || now >= signGraceUntil;
    default:
      // unknown/legacy value - fail safe to prompting
      return true;
  }
}

/**
 * Whether a successful password gate should (re)open the grace window. Only the
 * 'grace' level uses the window; 'foilhat' always re-prompts (so it must not
 * persist a skip) and 'unlock-only' never prompts.
 */
export function opensGraceWindow(level: TxSigningSecurity): boolean {
  return level === 'grace';
}

/**
 * Approve-button delay in seconds for the given level. Foilhat keeps the 3s
 * anti-haste delay; the faster levels drop it.
 */
export function approvalWaitSeconds(level: TxSigningSecurity): number {
  return level === 'foilhat' ? 3 : 0;
}
