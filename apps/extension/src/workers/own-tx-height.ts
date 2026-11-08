/**
 * Whether a payment this wallet broadcast is in a block, for the payments
 * sync cannot see: one that spends only transparent coins (a tex payment, a
 * thorchain deposit) has no note of ours, so no scanned spend ever confirms
 * it. It is asked of the server the wallet broadcast it through, which
 * already knows this client sent it, so the question tells it nothing new.
 * Shielded sends are never asked about: sync confirms them, and asking
 * would tie their txid to this client.
 */

import type { ZcashClient } from '../state/keyring/zcash-backend';
import type { SentTxRecord } from './sent-tx-reconcile';

const hexBytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], b => parseInt(b, 16));

/**
 * Whether the server has `txid` (`found`, mempool included) and the block it
 * is in. A failure reads as "not seen", never "gone". Backends disagree on
 * the byte order of TxFilter.hash, so display order is tried, then wire order.
 */
export const lookupOwnTx = async (
  client: Pick<ZcashClient, 'getTransaction'>,
  txid: string,
): Promise<{ found: boolean; height?: number }> => {
  const display = hexBytes(txid);
  for (const hash of [display, display.slice().reverse()]) {
    try {
      const raw = await client.getTransaction(hash);
      if (raw.data.length > 0) {
        return { found: true, height: raw.height > 0 ? raw.height : undefined };
      }
    } catch {
      // not in this order, or unreachable
    }
  }
  return { found: false };
};

/** a send of ours that only transparent coins paid, not yet seen in a block */
export const needsOwnLookup = (rec: SentTxRecord): boolean =>
  rec.pool === 'transparent' && rec.kind === 'send' && !(rec.confirmedHeight! > 0);

/**
 * The heights of the pending transparent-only sends, each asked at most once
 * per scanned height (`asked` remembers the last), so a sync loop asks once
 * per block, not once per pass.
 */
export const ownTxHeights = async (
  client: Pick<ZcashClient, 'getTransaction'>,
  sent: readonly SentTxRecord[],
  scannedHeight: number,
  asked: Map<string, number>,
): Promise<{ txid: string; height: number }[]> => {
  const found: { txid: string; height: number }[] = [];
  for (const rec of sent.filter(needsOwnLookup)) {
    if (asked.get(rec.txid) === scannedHeight) {
      continue;
    }
    asked.set(rec.txid, scannedHeight);
    const { height } = await lookupOwnTx(client, rec.txid);
    if (height) {
      found.push({ txid: rec.txid, height });
    }
  }
  return found;
};
