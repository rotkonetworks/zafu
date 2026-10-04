/**
 * Settle Ledger checkpoints left behind by a closed page, a lost connection or
 * an uncertain broadcast (vizor LedgerOperationRecoveryCoordinator). Never
 * touches the device:
 *
 *   signed               broadcast the stored bytes (the node answering
 *                        "already known" counts as accepted)
 *   broadcast_uncertain  look the txid up; seen -> acknowledged. Not seen ->
 *                        offer the same signed bytes again: accepted settles,
 *                        refused (expired / inputs spent) discards, no answer
 *                        keeps waiting. Never re-signed, never re-built.
 *   broadcast            acknowledge
 *
 * Only the operations of the CURRENT account on the CURRENT network are
 * touched, and each only while no signing surface holds its claim.
 *
 * Portions adapted from vizor-wallet (chainapsis/vizor-wallet, Apache-2.0), modified.
 */

import { settleBroadcast, type LedgerOperationContext, type LedgerTxDeps } from './operation';
import { withOperationClaim, type LedgerOperationStore } from './operations-store';

export interface LedgerRecoveryDeps {
  readonly store: LedgerOperationStore;
  readonly broadcast: LedgerTxDeps['broadcast'];
  /** Whether the backend has seen `txid` (display order). A failure is "not seen". */
  lookupTx(txid: string): Promise<{ found: boolean }>;
}

export interface LedgerRecoveryReport {
  /** broadcast now (they were only checkpointed) */
  readonly broadcast: string[];
  /** uncertain ones now seen on chain */
  readonly resolved: string[];
  /** still uncertain: not seen yet */
  readonly waiting: string[];
  /** the node refused a checkpointed tx; discarded */
  readonly rejected: string[];
  /** a signing surface owns it right now */
  readonly skipped: string[];
  readonly errors: { operationId: string; message: string }[];
}

export async function recoverLedgerOperations(
  deps: LedgerRecoveryDeps,
  ctx: LedgerOperationContext,
): Promise<LedgerRecoveryReport> {
  const report: LedgerRecoveryReport = {
    broadcast: [],
    resolved: [],
    waiting: [],
    rejected: [],
    skipped: [],
    errors: [],
  };
  const ops = await deps.store.list({ walletId: ctx.walletId, network: ctx.network });
  for (const meta of ops) {
    const id = meta.operationId;
    try {
      const claimed = await withOperationClaim(id, async () => {
        switch (meta.state) {
          case 'signed': {
            const full = await deps.store.get(id);
            if (!full?.txid) {
              return;
            }
            const settled = await settleBroadcast(
              deps.store,
              deps.broadcast,
              {
                operationId: id,
                walletId: full.walletId,
                signedTxHex: full.signedTxHex,
                txid: full.txid,
                ...(full.coldSendId ? { coldSendId: full.coldSendId } : {}),
              },
              ['signed'],
            );
            if (settled.status === 'broadcast') {
              report.broadcast.push(id);
            } else if (settled.status === 'rejected') {
              report.rejected.push(id);
            } else {
              report.waiting.push(id);
            }
            return;
          }
          case 'broadcast_uncertain': {
            if (!meta.txid) {
              report.waiting.push(id);
              return;
            }
            const { found } = await deps.lookupTx(meta.txid);
            if (found) {
              await deps.store.transition(id, ['broadcast_uncertain'], 'broadcast');
              await deps.store.acknowledge(id);
              report.resolved.push(id);
              return;
            }
            // Not seen: offer the SAME signed bytes again (same txid, so this is
            // idempotent at the network). Accepted / "already known" settles it;
            // a refusal (expired, inputs spent) discards it, so a lost tx can
            // never wedge the wallet. Never re-signed.
            const full = await deps.store.get(id);
            if (!full) {
              report.waiting.push(id);
              return;
            }
            const settled = await settleBroadcast(
              deps.store,
              deps.broadcast,
              {
                operationId: id,
                walletId: full.walletId,
                signedTxHex: full.signedTxHex,
                txid: meta.txid,
                ...(full.coldSendId ? { coldSendId: full.coldSendId } : {}),
              },
              ['broadcast_uncertain'],
            );
            if (settled.status === 'broadcast') {
              report.resolved.push(id);
            } else if (settled.status === 'rejected') {
              report.rejected.push(id);
            } else {
              report.waiting.push(id);
            }
            return;
          }
          case 'broadcast':
            await deps.store.acknowledge(id);
            report.resolved.push(id);
            return;
          case 'acknowledged':
            return;
        }
      });
      if (!claimed.claimed) {
        report.skipped.push(id);
      }
    } catch (e) {
      report.errors.push({ operationId: id, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
}
