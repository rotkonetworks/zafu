import { getDisplayDenomFromView } from '@penumbra-zone/getters/value-view';
import { fromValueView } from '@rotko/penumbra-types/amount';
import type { TransactionInfo } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { classifyPenumbraTx, type PenumbraTxType } from '../../../utils/penumbra-tx-classify';

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
  /** `amount` is a ceiling — change may exist but has not been scanned yet */
  amountUpperBound?: boolean;
  /** what the recipient got, excluding fee (amount = this + fee) */
  recipientAmount?: string;
  /** the fee paid, in ZEC, for the breakdown line */
  feeAmount?: string;
  /** who we sent it to, from our own record — the chain cannot recover this */
  recipient?: string;
  /** wall-clock ms at broadcast, used to date a row that has no height yet */
  sentAt?: number;
  /** penumbra account indices associated with this transaction (from visible actions) */
  accountIndices?: Set<number>;
}


/**
 * Best-effort amount + asset + destination for a penumbra recent-activity row.
 *
 * Penumbra's privacy model bounds what is recoverable after the fact, so this is
 * deliberately conservative about money display:
 *   - our OWN spend and change notes are visible to us, so the net amount that
 *     left (send / unshield) or arrived (receive / deposit / shield) in each
 *     asset is exact: sum(visible spends) - sum(visible outputs). This equals
 *     what moved through our wallet, fee included, matching the zcash row's
 *     `amount` semantics (amount = recipientAmount + fee).
 *   - a shielded recipient's output note is opaque to us, so the recipient
 *     address of a shielded send is NOT chain-recoverable and stays undefined.
 *   - an ics20 withdrawal (unshield) carries the transparent destination address
 *     in the clear, so "to where" is shown for those.
 *   - swaps net across two assets; we leave their amount to the "swap" label
 *     rather than pick a misleading single figure.
 */
function penumbraTxValue(
  txInfo: TransactionInfo,
  type: PenumbraTxType,
): { amount?: string; asset?: string; recipient?: string } {
  if (type === 'swap') {
    return {};
  }

  // per display-denom net balance = spends - outputs (positive = left our wallet)
  const net = new Map<string, ReturnType<typeof fromValueView>>();
  const addNote = (note: unknown, sign: 1 | -1) => {
    const value = (note as { value?: Parameters<typeof fromValueView>[0] } | undefined)?.value;
    if (!value?.valueView?.case) {
      return;
    }
    let denom: string;
    let amt: ReturnType<typeof fromValueView>;
    try {
      denom = getDisplayDenomFromView(value);
      amt = fromValueView(value);
    } catch {
      return;
    }
    if (!denom) {
      return;
    }
    const signed = amt.times(sign);
    const prev = net.get(denom);
    net.set(denom, prev ? prev.plus(signed) : signed);
  };

  let recipient: string | undefined;

  for (const action of txInfo.view?.bodyView?.actionViews ?? []) {
    const av = action.actionView;
    if (av.case === 'spend' && av.value.spendView?.case === 'visible') {
      addNote(av.value.spendView.value.note, 1);
    } else if (av.case === 'output' && av.value.outputView?.case === 'visible') {
      addNote(av.value.outputView.value.note, -1);
    } else if (av.case === 'ics20Withdrawal') {
      const dest = av.value.destinationChainAddress;
      if (dest) {
        recipient = dest;
      }
    }
  }

  // dominant denom by absolute net movement
  let bestDenom: string | undefined;
  let bestAbs: ReturnType<typeof fromValueView> | undefined;
  for (const [denom, v] of net) {
    const a = v.abs();
    if (!bestAbs || a.isGreaterThan(bestAbs)) {
      bestAbs = a;
      bestDenom = denom;
    }
  }

  if (!bestDenom || !bestAbs) {
    return { recipient };
  }
  // asset is known even when the net rounds to ~0 (e.g. an internal transfer)
  const amount = bestAbs.isZero() ? undefined : bestAbs.decimalPlaces(6).toString();
  return { amount, asset: bestDenom, recipient };
}


export function parsePenumbraTx(txInfo: TransactionInfo): ParsedTransaction {
  const id = txInfo.id?.inner
    ? Array.from(txInfo.id.inner)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
    : '';
  const height = Number(txInfo.height ?? 0);

  // canonical classification (shared with the full history page) - correctly
  // separates send / receive / unshield (ics20Withdrawal) / deposit
  // (ibcRelayAction) / swap / (un)delegate. The old local heuristic defaulted
  // any spend to 'send', so unshields to Noble read as sends.
  const { type, description, accountIndices } = classifyPenumbraTx(txInfo);

  // extract memo text if visible
  let memo: string | undefined;
  const memoView = txInfo.view?.bodyView?.memoView?.memoView;
  if (memoView?.case === 'visible' && memoView.value.plaintext?.text) {
    const text = memoView.value.plaintext.text.trim();
    if (text) {
      memo = text;
    }
  }

  // amount / asset / destination from the visible actions (privacy-bounded)
  const { amount, asset, recipient } = penumbraTxValue(txInfo, type);

  return {
    id,
    height,
    timestamp: null,
    type,
    description,
    memo,
    accountIndices,
    amount,
    asset,
    recipient,
  };
}

