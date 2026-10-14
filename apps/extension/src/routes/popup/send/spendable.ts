/**
 * What the send form is allowed to say about your money.
 *
 * The form used to advertise `getBalanceInWorker() - 10_000` as sendable. Three
 * things were wrong with that, and each one produced a send that failed only
 * after a full witness build and a halo2 prove:
 *
 *   1. 10,000 zat is not the fee. ZIP-317 prices a transaction by its LOGICAL
 *      ACTIONS - 5,000 zat times max(nSpends, nOutputs, 2) plus the transparent
 *      side - and the user can raise it with a multiplier. A wallet holding
 *      many small notes pays several times the flat figure, so "balance minus
 *      10,000" was not merely imprecise, it was unbuildable.
 *   2. That balance is orchard + ironwood COMBINED. Post-NU6.3 only ironwood
 *      is spendable: orchard→orchard sends are consensus-disabled and the
 *      worker fails closed on them. A wallet with 5 ZEC orchard and 0.01 ZEC
 *      ironwood was told it could send 5.0099.
 *   3. It excludes transparent UTXOs, which the home screen DOES include - so
 *      the two screens disagreed about the same wallet.
 *
 * This module is the arithmetic for (1) and (2), kept pure so it can be tested
 * against the worker's own fee function rather than trusted by inspection. It
 * mirrors `computeFee` / `selectNotes` in workers/zcash-worker.ts; that file
 * remains authoritative and the two must be changed together.
 */

/** ZIP-317 marginal fee per logical action, in zatoshi. */
export const MARGINAL_FEE = 5000n;
/** ZIP-317 grace: a transaction is never priced below this many actions. */
const GRACE_ACTIONS = 2;
/** Each non-empty shielded bundle is padded to this many actions for privacy. */
const MIN_SHIELDED_ACTIONS = 2;

/**
 * ZIP-317 fee, mirroring the worker's computeFee. Always the standard fee:
 * zcash has no fee market, so paying more buys no speed and only makes the
 * transaction stand out from every other wallet's.
 */
export const computeFeeZat = (
  nSpends: number,
  nZOutputs: number,
  nTOutputs: number,
  hasChange: boolean,
): bigint => {
  const nShieldedOutputs = nZOutputs + (hasChange ? 1 : 0);
  const nShieldedActions = Math.max(nSpends, nShieldedOutputs, MIN_SHIELDED_ACTIONS);
  const logicalActions = nShieldedActions + nTOutputs;
  return MARGINAL_FEE * BigInt(Math.max(logicalActions, GRACE_ACTIONS));
};

/**
 * Serialized size of one P2PKH `tx_in`: 32 (txid) + 4 (index) + 1 (script len)
 * + 107 (script_sig) + 4 (sequence).
 */
const P2PKH_TX_IN_SIZE = 148;
/** ZIP-317 divides the transparent byte total by this to get logical actions. */
const ZIP317_TX_BYTES_PER_ACTION = 150;

/**
 * ZIP-317 transparent-side logical actions for `n` P2PKH inputs:
 * `ceil(tx_in_total_size / 150)`.
 *
 * NOT `n`. `ceil(148n/150) === n` only while `2n < 150`; at n = 75 the byte
 * total is exactly 11_100 = 74 * 150, so the true count is 74 and every count
 * from 75 up is strictly below `n`. Using `n` overpaid one marginal fee per
 * ~75 inputs - safe for consensus (nodes only reject UNDER-payment) but a
 * wallet fingerprint on every large consolidation, since no ZIP-317-correct
 * wallet would pay it.
 *
 * Kept numerically identical to `zafu_wasm::zip317_transparent_actions` and to
 * zcli's `ops/shield.rs`; the wasm shielding builder RE-CHECKS the fee with the
 * same formula and refuses an under-payment, so these must not drift.
 */
const zip317TransparentActions = (nTInputs: number): number =>
  Math.ceil((nTInputs * P2PKH_TX_IN_SIZE) / ZIP317_TX_BYTES_PER_ACTION);

/**
 * ZIP-317 fee for a shielding transaction: one padded (2-action) shielded
 * bundle plus the transparent input side. The worker builds with it and the
 * shield sheet shows it.
 *
 * Deliberately does NOT apply the user fee multiplier - the shielding paths
 * never did, and the wasm builder re-checks this exact number, so keeping it at
 * the conventional fee leaves the two in lockstep.
 */
export const shieldFeeZat = (nTInputs: number): bigint => {
  const logicalActions = MIN_SHIELDED_ACTIONS + zip317TransparentActions(nTInputs);
  return MARGINAL_FEE * BigInt(Math.max(logicalActions, GRACE_ACTIONS));
};

/**
 * What shielding these coins costs, from the address of each coin: hot and
 * ledger send one transaction per address, zigner signs them all in one.
 */
export const shieldFeeFor = (coinAddresses: readonly string[], together: boolean): bigint => {
  if (together) {
    return coinAddresses.length ? shieldFeeZat(coinAddresses.length) : 0n;
  }
  const perAddress = new Map<string, number>();
  for (const a of coinAddresses) {
    perAddress.set(a, (perAddress.get(a) ?? 0) + 1);
  }
  return [...perAddress.values()].reduce((sum, n) => sum + shieldFeeZat(n), 0n);
};

/**
 * The worker's note selection: largest first, until the target is covered.
 * Returns the selected values, or undefined when the notes cannot cover the
 * target - the same condition the worker throws "insufficient funds" on.
 */
const selectValues = (values: bigint[], target: bigint): bigint[] | undefined => {
  const sorted = [...values].sort((a, b) => (a === b ? 0 : a > b ? -1 : 1));
  const picked: bigint[] = [];
  let total = 0n;
  for (const v of sorted) {
    total += v;
    picked.push(v);
    if (total >= target) {
      return picked;
    }
  }
  return undefined;
};

export interface SpendableMax {
  /** zatoshi that can actually be sent, fee already deducted. Never negative. */
  amountZat: bigint;
  /** the fee that amount was priced with */
  feeZat: bigint;
  /** how many notes such a send would spend */
  nSpends: number;
}

/**
 * The largest amount this set of notes can actually send.
 *
 * A max send spends EVERY note in the pool and produces no change, so the fee
 * is determined: `computeFee(nNotes, outputs, 0/1, hasChange=false)`. There is
 * no fixed point to solve for - unlike a partial send, where the amount decides
 * the note count which decides the fee which decides the note count.
 *
 * Returns zero (not a negative) when the fee exceeds the balance: dust that
 * cannot pay for its own transaction is not spendable, and saying so is the
 * point of this function.
 */
export const maxSendable = (
  noteValues: bigint[],
  opts: { transparentRecipient: boolean },
): SpendableMax => {
  const total = noteValues.reduce((s, v) => s + v, 0n);
  const nTOutputs = opts.transparentRecipient ? 1 : 0;
  const nZOutputs = opts.transparentRecipient ? 0 : 1;
  const feeZat = computeFeeZat(noteValues.length, nZOutputs, nTOutputs, false);
  if (total <= feeZat) {
    return { amountZat: 0n, feeZat, nSpends: noteValues.length };
  }
  return { amountZat: total - feeZat, feeZat, nSpends: noteValues.length };
};

export type QuoteError = 'insufficient' | 'dust';

export interface SendQuote {
  ok: boolean;
  /** which notes the build would select, and what it would cost */
  feeZat: bigint;
  nSpends: number;
  /** set when ok === false */
  error?: QuoteError;
  /** total the wallet would need for this amount, amount + fee */
  requiredZat: bigint;
}

/**
 * Price a specific amount the way the worker will, BEFORE the build.
 *
 * The worker selects notes for `amount + estimatedFee`, then re-prices on the
 * real spend count and re-checks. Reproducing that here is what turns a
 * two-minute prove ending in a raw zatoshi error into an inline message on the
 * form. It is intentionally the same three steps, in the same order.
 */
export const quoteSend = (
  noteValues: bigint[],
  amountZat: bigint,
  opts: { transparentRecipient: boolean },
): SendQuote => {
  const nTOutputs = opts.transparentRecipient ? 1 : 0;
  const nZOutputs = opts.transparentRecipient ? 0 : 1;

  if (amountZat <= 0n) {
    return { ok: false, error: 'dust', feeZat: 0n, nSpends: 0, requiredZat: 0n };
  }

  const estFee = computeFeeZat(1, nZOutputs, nTOutputs, true);
  const selected = selectValues(noteValues, amountZat + estFee);
  if (!selected) {
    const fee = computeFeeZat(noteValues.length, nZOutputs, nTOutputs, false);
    return {
      ok: false,
      error: 'insufficient',
      feeZat: fee,
      nSpends: noteValues.length,
      requiredZat: amountZat + fee,
    };
  }

  const totalIn = selected.reduce((s, v) => s + v, 0n);
  const hasChange =
    totalIn > amountZat + computeFeeZat(selected.length, nZOutputs, nTOutputs, true);
  const feeZat = computeFeeZat(selected.length, nZOutputs, nTOutputs, hasChange);
  const requiredZat = amountZat + feeZat;
  return {
    ok: totalIn >= requiredZat,
    error: totalIn >= requiredZat ? undefined : 'insufficient',
    feeZat,
    nSpends: selected.length,
    requiredZat,
  };
};
