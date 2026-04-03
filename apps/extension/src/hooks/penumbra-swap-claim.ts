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
      console.error('[swap-claim] failed to claim swap:', err);
    }
  }

  return claimed;
}

export function usePenumbraSwapClaim(activeNetwork: string, onLoginPage: boolean, penumbraAccount: number) {
  const claimingRef = useRef(false);

  useEffect(() => {
    if (activeNetwork !== 'penumbra') return;
    if (onLoginPage) return;

    const tryClaimOnce = () => {
      if (claimingRef.current) return;
      claimingRef.current = true;

      claimUnclaimedSwaps(penumbraAccount)
        .then(n => { if (n > 0) console.log(`[swap-claim] claimed ${n} swap(s)`); })
        .catch(err => console.error('[swap-claim] auto-claim error:', err))
        .finally(() => { claimingRef.current = false; });
    };

    // initial check after sync settles
    const timer = setTimeout(tryClaimOnce, 5000);
    // re-check every 30s for swaps made during this session
    const interval = setInterval(tryClaimOnce, 30_000);

    return () => { clearTimeout(timer); clearInterval(interval); };
  }, [activeNetwork, onLoginPage, penumbraAccount]);
}
