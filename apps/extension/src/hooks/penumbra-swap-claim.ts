/**
 * auto-claim unclaimed penumbra swaps
 *
 * after a swap tx is confirmed, the outputs sit as unclaimed swap NFTs
 * until a claim transaction is submitted. on every newly scanned block this
 * hook claims every swap that is ready, in one transaction per prepaid fee
 * asset, without waiting for the claim to land (see swap-claim-batches.ts).
 * Every open view runs it; one claims at a time, and all share what was sent.
 *
 * runs in PopupLayout, so claims happen while a zafu surface is open and
 * catch up on the next open (nothing calls out while every window is closed).
 */

import { useEffect, useRef } from 'react';
import { viewClient } from '../clients';
import { TransactionPlannerRequest } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { hexToUint8Array, uint8ArrayToHex } from '@penumbrafi/types/hex';
import { CAUGHT_UP_BLOCKS, useLatestBlockHeight } from './latest-block-height';
import { usePenumbraSync } from './full-sync-height';
import {
  claimBatches,
  pruneSent,
  sendClaimBatches,
  SENT_CLAIMS_KEY,
  sentFromStored,
  sentToStored,
  type UnclaimedSwap,
} from './swap-claim-batches';

/**
 * Recognize the ConnectRPC error you get when the MessagePort to the
 * service worker has been closed - happens when Chrome recycles the SW
 * (~30s idle) or while the popup is being torn down. This is benign;
 * the next block gets a fresh port and will retry, so we don't want
 * to surface it as an error.
 */
function isTransientPortClosure(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const msg = String((err as { message?: unknown }).message ?? '');
  return (
    msg.includes('[unavailable]') ||
    msg.includes('Connection closed') ||
    msg.includes('port closed') ||
    msg.includes('extension context invalidated')
  );
}

/** build and broadcast one claim transaction; 'transient' when the worker went away */
async function claimBatch(account: number, batch: string[]): Promise<'sent' | 'transient'> {
  try {
    const { plan } = await viewClient.transactionPlanner(
      new TransactionPlannerRequest({
        swapClaims: batch.map(c => ({ swapCommitment: { inner: hexToUint8Array(c) } })),
        source: { account },
      }),
    );
    if (!plan) {
      throw new Error('no plan for the claim');
    }
    let transaction;
    for await (const msg of await viewClient.authorizeAndBuild({ transactionPlan: plan })) {
      if (msg.status.case === 'complete') {
        transaction = msg.status.value.transaction;
        break;
      }
    }
    if (!transaction) {
      throw new Error('the claim was not built');
    }
    // sent, not confirmed: it lands next block; until then these are skipped
    for await (const msg of await viewClient.broadcastTransaction({ transaction })) {
      if (msg.status.case === 'broadcastSuccess') {
        break;
      }
    }
    return 'sent';
  } catch (err) {
    if (isTransientPortClosure(err)) {
      // service worker recycled mid-claim; the next block retries.
      console.debug('[swap-claim] port closed during claim, will retry next block');
      return 'transient';
    }
    throw err;
  }
}

/**
 * Claim every ready swap, one transaction per fee asset; returns claims sent.
 *
 * Popup, side panel and a tab each run this hook. One of them claims at a
 * time (a Web Lock shared by every extension page), and what was sent is kept
 * in session storage, so the others see it and do not plan, prove and
 * broadcast the same claims again.
 */
async function claimUnclaimedSwaps(account: number, height: number): Promise<number> {
  const run = async () => {
    const unclaimed: UnclaimedSwap[] = [];
    for await (const { swap } of viewClient.unclaimedSwaps({})) {
      if (swap?.swapCommitment) {
        unclaimed.push({
          commitment: uint8ArrayToHex(swap.swapCommitment.inner),
          feeAsset: uint8ArrayToHex(swap.swap?.claimFee?.assetId?.inner ?? new Uint8Array()),
        });
      }
    }
    const sent = sentFromStored(
      (await chrome.storage.session.get(SENT_CLAIMS_KEY))[SENT_CLAIMS_KEY],
    );
    pruneSent(sent, unclaimed);
    try {
      return await sendClaimBatches(
        claimBatches(unclaimed, sent, height),
        sent,
        height,
        batch => claimBatch(account, batch),
        (err, batch) => console.error(`[swap-claim] failed to claim ${batch.length} swap(s):`, err),
      );
    } finally {
      await chrome.storage.session.set({ [SENT_CLAIMS_KEY]: sentToStored(sent) });
    }
  };
  // another view is claiming right now: it covers these claims
  return navigator.locks.request('penumbra-swap-claim', { ifAvailable: true }, lock =>
    lock ? run() : 0,
  );
}

export function usePenumbraSwapClaim(
  activeNetwork: string,
  onLoginPage: boolean,
  penumbraAccount: number,
) {
  const claimingRef = useRef(false);
  const fullSyncHeight = usePenumbraSync()?.height;
  const { data: latestBlockHeight } = useLatestBlockHeight();

  const synced =
    fullSyncHeight !== undefined &&
    latestBlockHeight !== undefined &&
    latestBlockHeight - fullSyncHeight <= CAUGHT_UP_BLOCKS;

  // each newly scanned block may finish swaps: claim them right away
  useEffect(() => {
    if (activeNetwork !== 'penumbra' || onLoginPage || !synced || fullSyncHeight === undefined) {
      return;
    }
    const tryClaimOnce = () => {
      if (claimingRef.current) {
        return;
      }
      claimingRef.current = true;

      claimUnclaimedSwaps(penumbraAccount, Number(fullSyncHeight))
        .then(n => {
          if (n > 0) {
            console.debug(`[swap-claim] sent ${n} claim(s)`);
          }
        })
        .catch(err => {
          if (isTransientPortClosure(err)) {
            console.debug('[swap-claim] port closed before claim started, will retry');
          } else if (String(err).includes('penumbra network not')) {
            // penumbra was just turned off or switched away from: nothing to claim
            console.debug('[swap-claim] penumbra is not running, skipped');
          } else {
            console.error('[swap-claim] auto-claim error:', err);
          }
        })
        .finally(() => {
          claimingRef.current = false;
        });
    };

    tryClaimOnce();
  }, [activeNetwork, onLoginPage, penumbraAccount, synced, fullSyncHeight]);
}
