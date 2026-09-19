/**
 * Decimal -> base-unit conversion for IBC withdrawals.
 *
 * Kept in its own module (no store / no `viewClient` imports) so it is a pure,
 * cheaply testable function.
 *
 * The previous implementation was `BigInt(Math.floor(parseFloat(amount) * 1e6))`,
 * which is wrong twice over:
 *
 *   - the exponent was hardcoded to 6, so an 18-decimal asset (INJ) was scaled
 *     by 1e6 and the user sent a trillionth of what they typed;
 *   - `parseFloat` * power-of-ten is binary floating point, so amounts that are
 *     not exactly representable round DOWN a base unit ("0.29" * 1e6 is
 *     289999.99999999997, floored to 289999).
 *
 * Here the decimal string is parsed as a string and scaled by digit shifting,
 * so no float ever touches the value.
 */

/** `123`, `123.45`, `.45` - no sign, no exponent notation, no separators. */
const DECIMAL_RE = /^(\d*)(?:\.(\d*))?$/;

/**
 * Convert a human-entered decimal amount into base units for an asset whose
 * display denom sits at `exponent` decimal places.
 *
 * Throws (rather than truncating) when the input carries more fractional digits
 * than the asset can represent - silently dropping a user's digits is how you
 * send the wrong amount.
 */
export const toBaseUnits = (amount: string, exponent: number): bigint => {
  if (!Number.isInteger(exponent) || exponent < 0) {
    throw new Error(`invalid decimal exponent: ${exponent}`);
  }

  const trimmed = amount.trim();
  if (!trimmed) {
    throw new Error('amount is empty');
  }

  const match = DECIMAL_RE.exec(trimmed);
  if (!match) {
    throw new Error(`invalid amount: ${amount}`);
  }

  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  if (!whole && !fraction) {
    // matched only "." or ""
    throw new Error(`invalid amount: ${amount}`);
  }

  if (fraction.length > exponent) {
    throw new Error(
      `amount has ${fraction.length} decimal places but this asset supports at most ${exponent}`,
    );
  }

  return BigInt(`${whole || '0'}${fraction.padEnd(exponent, '0')}`);
};

/**
 * `true` when `toBaseUnits` would accept the input and produce a non-zero
 * amount. For input validation in the UI, where throwing is the wrong shape.
 */
export const isValidWithdrawAmount = (amount: string, exponent: number): boolean => {
  try {
    return toBaseUnits(amount, exponent) > 0n;
  } catch {
    return false;
  }
};
