/**
 * auto-claim unclaimed penumbra swaps
 *
 * after a swap tx is confirmed, the outputs sit as unclaimed swap NFTs
 * until a claim transaction is submitted. this hook detects unclaimed
 * swaps and automatically claims them in the background.
 *
 * runs in PopupLayout so it persists across tab navigation.
 */

import { useEffect, useRef } from 'react';
import { viewClient } from '../clients';
import { TransactionPlannerRequest } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { useStore } from '../state';
import { useLatestBlockHeight } from './latest-block-height';

/**
 * Recognize the ConnectRPC error you get when the MessagePort to the
 * service worker has been closed — happens when Chrome recycles the SW
 * (~30s idle) or while the popup is being torn down. This is benign;
 * the next 30s tick gets a fresh port and will retry, so we don't want
 * to surface it as an error.
 */
function isTransientPortClosure(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const msg = String((err as { message?: unknown }).message ?? '');
  return (
    msg.includes('[unavailable]') ||
    msg.includes('Connection closed') ||
    msg.includes('port closed') ||
    msg.includes('extension context invalidated')
  );
}

/** claim all unclaimed swaps, one at a time */
async function claimUnclaimedSwaps(account: number): Promise<number> {
  const unclaimed = await Array.fromAsync(viewClient.unclaimedSwaps({}));
  if (!unclaimed.length) return 0;

  let claimed = 0;
  for (const resp of unclaimed) {
    const swap = resp.swap;
    if (!swap?.swapCommitment) continue;

    try {
      // 1. plan the claim — source account from the swap's claim address
      const planRequest = new TransactionPlannerRequest({
        swapClaims: [{ swapCommitment: swap.swapCommitment }],
        source: { account },
      });
      const { plan } = await viewClient.transactionPlanner(planRequest);
      if (!plan) continue;

      // 2. build
      let transaction;
      for await (const msg of await viewClient.authorizeAndBuild({ transactionPlan: plan })) {
        if (msg.status.case === 'complete') {
          transaction = msg.status.value.transaction;
          break;
        }
      }
      if (!transaction) continue;

      // 3. broadcast (don't await detection — fire and forget)
      for await (const msg of await viewClient.broadcastTransaction({ transaction, awaitDetection: true })) {
        if (msg.status.case === 'confirmed') {
          claimed++;
          break;
        }
      }
    } catch (err) {
      if (isTransientPortClosure(err)) {
        // service worker recycled mid-claim; the next tick retries.
        console.debug('[swap-claim] port closed during claim, will retry next tick');
        return claimed;
      }
      console.error('[swap-claim] failed to claim swap:', err);
    }
  }

  return claimed;
}

export function usePenumbraSwapClaim(activeNetwork: string, onLoginPage: boolean, penumbraAccount: number) {
  const claimingRef = useRef(false);
  const fullSyncHeight = useStore((state: { network: { fullSyncHeight?: number } }) => state.network.fullSyncHeight);
  const { data: latestBlockHeight } = useLatestBlockHeight();

  // track sync state in a ref so the interval callback always sees latest values
  // without re-creating timers on every sync height update
  const syncRef = useRef({ fullSyncHeight, latestBlockHeight });
  syncRef.current = { fullSyncHeight, latestBlockHeight };

  useEffect(() => {
    if (activeNetwork !== 'penumbra') return;
    if (onLoginPage) return;

    const isSynced = () => {
      const { fullSyncHeight: fsh, latestBlockHeight: lbh } = syncRef.current;
      return fsh !== undefined && lbh !== undefined && lbh - fsh <= 10;
    };

    const tryClaimOnce = () => {
      if (claimingRef.current) return;
      if (!isSynced()) return;
      claimingRef.current = true;

      claimUnclaimedSwaps(penumbraAccount)
        .then(n => { if (n > 0) console.log(`[swap-claim] claimed ${n} swap(s)`); })
        .catch(err => {
          if (isTransientPortClosure(err)) {
            console.debug('[swap-claim] port closed before claim started, will retry');
          } else {
            console.error('[swap-claim] auto-claim error:', err);
          }
        })
        .finally(() => { claimingRef.current = false; });
    };

    // initial check after sync settles
    const timer = setTimeout(tryClaimOnce, 5000);
    // re-check every 30s for swaps made during this session
    const interval = setInterval(tryClaimOnce, 30_000);

    return () => { clearTimeout(timer); clearInterval(interval); };
  }, [activeNetwork, onLoginPage, penumbraAccount]);
}
