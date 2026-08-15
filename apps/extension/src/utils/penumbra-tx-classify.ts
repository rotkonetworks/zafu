/**
 * Canonical Penumbra transaction classification, shared by the home "recent
 * activity" list and the full history page. Both used to hand-roll this and
 * drifted - the home parser had no ics20Withdrawal case, so unshields (IBC
 * withdrawals to a transparent chain like Noble) showed up as generic "send".
 * One source of truth here prevents that class of bug from recurring.
 */

import type { TransactionInfo } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import {
  classifyTransaction,
  getTransactionClassificationLabel,
} from '@penumbra-zone/perspective/transaction/classify';
import type { TransactionClassification } from '@penumbra-zone/perspective/transaction/classification';

export type PenumbraTxType =
  | 'send'
  | 'receive'
  | 'shield'
  | 'unshield'
  | 'deposit'
  | 'swap'
  | 'delegate'
  | 'undelegate'
  | 'unknown';

/** map the canonical perspective classification to zafu's display type */
const CLASSIFICATION_TO_TYPE: Partial<Record<TransactionClassification, PenumbraTxType>> = {
  send: 'send',
  receive: 'receive',
  internalTransfer: 'send',
  ics20Withdrawal: 'unshield',
  ibcRelayAction: 'deposit',
  swap: 'swap',
  swapClaim: 'swap',
  delegate: 'delegate',
  undelegate: 'undelegate',
  undelegateClaim: 'undelegate',
};

/** extract account index from a visible note's decoded address view */
function noteAccountIndex(note: unknown): number | undefined {
  const n = note as
    | { address?: { addressView?: { case?: string; value?: { index?: { account?: number } } } } }
    | undefined;
  if (!n?.address?.addressView) {
    return undefined;
  }
  const av = n.address.addressView;
  if (av.case === 'decoded' && av.value?.index != null) {
    return av.value.index.account;
  }
  return undefined;
}

/**
 * Penumbra account indices touched by a transaction, drawn from the visible
 * spend / output / swap / swapClaim notes. Used for per-account filtering.
 */
export function penumbraAccountIndices(txInfo: TransactionInfo): Set<number> {
  const accountIndices = new Set<number>();
  for (const action of txInfo.view?.bodyView?.actionViews ?? []) {
    const c = action.actionView.case;
    if (c === 'spend' && action.actionView.value.spendView?.case === 'visible') {
      const idx = noteAccountIndex(action.actionView.value.spendView.value?.note);
      if (idx != null) {
        accountIndices.add(idx);
      }
    } else if (c === 'output') {
      const ov = action.actionView.value.outputView;
      if (ov?.case === 'visible') {
        const idx = noteAccountIndex(ov.value?.note);
        if (idx != null) {
          accountIndices.add(idx);
        }
      }
    } else if (c === 'swap') {
      const sv = action.actionView.value.swapView;
      if (sv?.case === 'visible') {
        const v = sv.value as { output1?: unknown; output2?: unknown };
        for (const out of [v.output1, v.output2]) {
          const idx = noteAccountIndex(out);
          if (idx != null) {
            accountIndices.add(idx);
          }
        }
      }
    } else if (c === 'swapClaim') {
      // swap claims are separate txs with no spend/output actions - the account
      // is only recoverable from the claim's output notes
      const scv = action.actionView.value.swapClaimView;
      if (scv?.case === 'visible') {
        const v = scv.value as { output1?: unknown; output2?: unknown };
        for (const out of [v.output1, v.output2]) {
          const idx = noteAccountIndex(out);
          if (idx != null) {
            accountIndices.add(idx);
          }
        }
      }
    }
  }
  return accountIndices;
}

/**
 * Classify a transaction into zafu's display type + label using the canonical
 * perspective classifier. This correctly separates send / receive / unshield
 * (ics20Withdrawal) / deposit (ibcRelayAction) / swap / (un)delegate - the old
 * heuristic defaulted any spend to 'send', so unshields read as sends.
 */
export function classifyPenumbraTx(txInfo: TransactionInfo): {
  type: PenumbraTxType;
  description: string;
  accountIndices: Set<number>;
} {
  const classification = classifyTransaction(txInfo.view).type;
  const type = CLASSIFICATION_TO_TYPE[classification] ?? 'unknown';
  const description = getTransactionClassificationLabel(txInfo.view).toLowerCase();
  return { type, description, accountIndices: penumbraAccountIndices(txInfo) };
}
