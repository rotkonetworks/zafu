/**
 * A payment from the pocket's own transparent coins that zafu has no record
 * of (a record lost to an older build's pruning, a restore, the same seed
 * used elsewhere), rebuilt from the transparent history the person's check
 * already fetched: no new request. What our coins paid out is the payment;
 * what came back to our scripts is change; what is left is the fee. When
 * the coins it spent came from one of our own recorded sends (the move to a
 * fresh address), that send is its move, so history folds the two.
 */

import type { SentTxRecord } from './sent-tx-reconcile';

/** a transparent transaction touching the pocket, as the check read it */
export interface TOuts {
  txid: string;
  height: number;
  /** the outpoints it spends, display-order txids */
  inputs: { txid: string; vout: number }[];
  outputs: { value: bigint; script: string; ours: boolean }[];
}

/**
 * Records for the transactions that spend our coins and that `known` (the
 * txids zafu recorded) doesn't hold. `addressOf` names the first output paid
 * away; a payment with no output paid away (a self-transfer) is not one.
 */
export const rebuildSends = async (
  rows: readonly TOuts[],
  known: ReadonlySet<string>,
  walletId: string,
  addressOf: (script: string) => Promise<string | undefined>,
): Promise<SentTxRecord[]> => {
  const ourCoins = new Map<string, bigint>();
  for (const r of rows) {
    r.outputs.forEach((o, vout) => {
      if (o.ours) {
        ourCoins.set(`${r.txid}:${vout}`, o.value);
      }
    });
  }
  const out: SentTxRecord[] = [];
  for (const r of rows) {
    if (known.has(r.txid) || r.height <= 0) {
      continue;
    }
    const spent = r.inputs.map(i => ourCoins.get(`${i.txid}:${i.vout}`));
    // every input ours, so the fee is ours to name; anything else is not our payment to tell
    if (!spent.length || spent.some(v => v === undefined)) {
      continue;
    }
    const away = r.outputs.filter(o => !o.ours);
    if (!away.length) {
      continue;
    }
    const inTotal = spent.reduce<bigint>((n, v) => n + v!, 0n);
    const paid = away.reduce((n, o) => n + o.value, 0n);
    const change = r.outputs.filter(o => o.ours).reduce((n, o) => n + o.value, 0n);
    const fee = inTotal - paid - change;
    if (fee < 0n) {
      continue;
    }
    const move = r.inputs.find(i => known.has(i.txid))?.txid;
    out.push({
      walletId,
      txid: r.txid,
      amount: paid.toString(),
      fee: fee.toString(),
      recipient: (await addressOf(away[0]!.script)) ?? '',
      pool: 'transparent',
      kind: 'send',
      sentAt: 0,
      confirmedHeight: r.height,
      ...(move ? { moveTxid: move } : {}),
    });
  }
  return out;
};
