/**
 * Typed errors for the zid SDK.
 *
 * The wallet answers over the wire with ad-hoc `{ error }` / `{ success: false }`
 * shapes; the raw provider helpers historically collapsed every failure to
 * `null`, so a dapp building "Login with Zafu" could not tell "no wallet" from
 * "user denied" from "wallet locked". These give a dapp a real signal to branch
 * on (show an install CTA, a retry, an unlock hint, ...).
 */

export type ZafuErrorCode =
  /** no zafu wallet is reachable (not installed, or the extension is off). */
  | 'unavailable'
  /** a wallet is present but speaks a protocol major this SDK does not. */
  | 'incompatible'
  /** the wallet is locked - the user must enter their password. */
  | 'locked'
  /** the user declined the request in the wallet. */
  | 'denied'
  /** the origin exceeded the wallet's rate limit. */
  | 'rate_limited'
  /** the feature is turned off in wallet settings (e.g. the identity layer). */
  | 'not_available'
  /** the wallet returned an error that does not map to a more specific code. */
  | 'wallet_error'
  /** the message could not be delivered to the wallet (timeout, disconnect). */
  | 'transport_error';

export class ZafuError extends Error {
  readonly code: ZafuErrorCode;
  constructor(code: ZafuErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'ZafuError';
    this.code = code;
  }
}

/**
 * Map a wallet error string to a typed code. The wallet's strings are not a
 * stable contract, so match loosely and fall back to `wallet_error`.
 */
export function classifyWalletError(msg: string | undefined): ZafuError {
  const m = (msg ?? '').toLowerCase();
  if (m.includes('locked')) {
    return new ZafuError('locked', msg);
  }
  if (m.includes('rate limit')) {
    return new ZafuError('rate_limited', msg);
  }
  if (m.includes('denied') || m.includes('rejected') || m.includes('user declined')) {
    return new ZafuError('denied', msg);
  }
  if (m.includes('disabled') || m.includes('not available') || m.includes('unavailable')) {
    return new ZafuError('not_available', msg);
  }
  return new ZafuError('wallet_error', msg || 'wallet error');
}
