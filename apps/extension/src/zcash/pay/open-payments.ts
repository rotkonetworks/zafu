/**
 * Payments from a fresh transparent address in flight (a tex paid from the
 * shielded pool), between visits: the reviewed payment, its move once sent,
 * a zigner payment held for the move's block. Sealed at rest
 * (ENCRYPTED_KEYS 'openPayments'): the recipient and the fresh address are
 * never in the clear. A record is forgotten once the payment goes out; the
 * sent payment's own history row takes over from there. It is not a
 * setting, so it is not in the personal backup.
 */

import { sealedList } from '../../state/sealed-list';
import type { FreshPayment } from './via-fresh';

export const OPEN_PAYMENTS_KEY = 'openPayments';

export interface OpenPayment extends FreshPayment {
  v: 1;
  /** the pocket store it belongs to */
  wallet: string;
  /** when the person confirmed it */
  at: number;
}

/** a stored value is an open payment only if it has the shape this build writes */
export const isOpenPayment = (v: unknown): v is OpenPayment => {
  const p = v as OpenPayment;
  return (
    !!p &&
    typeof p === 'object' &&
    p.v === 1 &&
    typeof p.id === 'string' &&
    typeof p.wallet === 'string' &&
    !!p.req &&
    typeof p.req.tAddress === 'string' &&
    typeof p.req.to === 'string' &&
    typeof p.req.amountZat === 'string' &&
    typeof p.req.reviewedFee === 'string'
  );
};

export const openPayments = sealedList(OPEN_PAYMENTS_KEY, isOpenPayment);
