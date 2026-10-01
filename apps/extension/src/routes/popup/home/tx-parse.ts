import type { PenumbraEntry, PenumbraKind } from '../../../history/penumbra-describe';

export type PenumbraTxType =
  | 'send'
  | 'receive'
  | 'shield'
  | 'unshield'
  | 'deposit'
  | 'swap'
  | 'liquidity'
  | 'delegate'
  | 'undelegate'
  | 'unknown';

// ── history ──

export interface ParsedTransaction {
  id: string;
  height: number;
  timestamp: number | null;
  type: PenumbraTxType;
  description: string;
  amount?: string;
  asset?: string;
  memo?: string;
  /**
   * Confirmation state, for transactions where we can tell the difference.
   * Absent means the entry came from a source that only ever reports settled
   * transactions (penumbra), and is treated as confirmed.
   */
  status?: 'pending' | 'confirmed' | 'failed';
  /** `amount` is a ceiling - change may exist but has not been scanned yet */
  amountUpperBound?: boolean;
  /** what the recipient got, excluding fee (amount = this + fee) */
  recipientAmount?: string;
  /** the fee paid, in ZEC, for the breakdown line */
  feeAmount?: string;
  /** who we sent it to, from our own record - the chain cannot recover this */
  recipient?: string;
  /** wall-clock ms at broadcast, used to date a row that has no height yet */
  sentAt?: number;
  /** penumbra account indices associated with this transaction (from visible actions) */
  accountIndices?: Set<number>;
  /** the decoded penumbra transaction this row came from */
  entry?: PenumbraEntry;
}

const KIND_TYPE: Record<PenumbraKind, PenumbraTxType> = {
  send: 'send',
  receive: 'receive',
  internal: 'send',
  deposit: 'deposit',
  withdraw: 'unshield',
  refund: 'deposit',
  swap: 'swap',
  liquidity: 'liquidity',
  stake: 'delegate',
  unstake: 'undelegate',
  'unstake-claim': 'undelegate',
  vote: 'unknown',
  unknown: 'unknown',
};

/** a decoded penumbra transaction as an activity row */
export const penumbraRow = (e: PenumbraEntry): ParsedTransaction => ({
  id: e.id,
  height: e.height,
  timestamp: null,
  type: KIND_TYPE[e.kind],
  description: e.title,
  amount: e.amounts[0]?.amount,
  asset: e.amounts[0]?.asset.display,
  memo: e.memo,
  recipient: e.counterparty?.label === 'to' ? e.counterparty.raw : undefined,
  feeAmount: e.fee && `${e.fee.exact} ${e.fee.asset.display}`,
  accountIndices: e.accountIndices,
  entry: e,
});

/** money arrived: the decoded direction when there is one, else the type */
export const isIncoming = (tx: ParsedTransaction): boolean =>
  tx.entry
    ? tx.entry.amounts[0]?.direction === 'in'
    : tx.type === 'receive' || tx.type === 'deposit';
