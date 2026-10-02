/**
 * hook to sync penumbra transaction memos into the inbox
 *
 * extracts memos from transaction history and adds them to messages store
 */

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { viewClient, sctClient } from '../clients';
import { useStore } from '../state';
import { messagesSelector } from '../state/messages';
import { bech32mAddress } from '@penumbra-zone/bech32m/penumbra';
import { getAddress as getAddressFromView } from '@penumbra-zone/getters/address-view';
import { getAmount as getAmountFromView } from '@penumbra-zone/getters/value-view';
import type { TransactionInfo } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';

interface ExtractedMemo {
  txId: string;
  blockHeight: number;
  timestamp: number;
  content: string;
  senderAddress?: string;
  recipientAddress: string;
  direction: 'sent' | 'received';
  amount?: string;
  asset?: string;
}

/**
 * extract memo from a transaction view
 */
function extractMemoFromTransaction(txInfo: TransactionInfo): ExtractedMemo | null {
  const view = txInfo.view;
  if (!view?.bodyView?.memoView?.memoView) {
    return null;
  }

  const memoView = view.bodyView.memoView.memoView;

  // only extract visible memos (decrypted)
  if (memoView.case !== 'visible') {
    return null;
  }

  const plaintext = memoView.value.plaintext;
  if (!plaintext?.text || plaintext.text.trim() === '') {
    return null;
  }

  // get transaction id as hex
  const txId = txInfo.id?.inner
    ? Array.from(txInfo.id.inner)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
    : '';

  // get return address (sender for received, empty for sent)
  let senderAddress: string | undefined;
  if (plaintext.returnAddress) {
    try {
      const address = getAddressFromView(plaintext.returnAddress);
      if (address) {
        senderAddress = bech32mAddress(address);
      }
    } catch {
      // invalid address
    }
  }

  // determine direction:
  // - if we have visible SPEND actions, we funded this tx = we SENT
  // - if we only have visible OUTPUT actions (no spends), we RECEIVED
  let hasVisibleSpend = false;
  let direction: 'sent' | 'received' = 'received'; // default to received
  let recipientAddress = '';
  let ourAddress: string | undefined;
  let amount: string | undefined;
  let asset: string | undefined;

  // check for spend actions (if we have spends, we sent this tx)
  for (const action of view.bodyView?.actionViews ?? []) {
    if (action.actionView.case === 'spend') {
      const spend = action.actionView.value;
      if (spend.spendView?.case === 'visible') {
        hasVisibleSpend = true;
        const note = spend.spendView.value.note;
        if (note?.address) {
          try {
            const address = getAddressFromView(note.address);
            if (address) {
              ourAddress = bech32mAddress(address);
            }
          } catch {
            // invalid
          }
        }
      }
    }
  }

  // if we have visible spends, we funded this = we sent it
  if (hasVisibleSpend) {
    direction = 'sent';
  }

  // extract output info (recipient address and amount)
  for (const action of view.bodyView?.actionViews ?? []) {
    if (action.actionView.case === 'output') {
      const output = action.actionView.value;
      if (output.outputView?.case === 'visible') {
        const note = output.outputView.value.note;
        if (note?.address) {
          try {
            const address = getAddressFromView(note.address);
            if (address) {
              const outputAddr = bech32mAddress(address);
              // for sent: recipient is the output that's NOT our address (skip change outputs)
              // for received: recipient is us (the output address)
              if (direction === 'sent') {
                if (outputAddr !== ourAddress) {
                  recipientAddress = outputAddr;
                }
              } else {
                // received - the output is to us
                recipientAddress = outputAddr;
              }
            }
          } catch {
            // invalid
          }
        }
        // extract amount from ValueView
        if (note?.value) {
          const amountValue = getAmountFromView(note.value);
          if (amountValue) {
            const lo = amountValue.lo ?? 0n;
            const hi = amountValue.hi ?? 0n;
            amount = ((hi << 64n) + lo).toString();
          }
        }
      }
    }
  }

  const blockHeight = Number(txInfo.height ?? 0);

  return {
    txId,
    blockHeight,
    timestamp: 0, // will be fetched from SctService
    content: plaintext.text,
    senderAddress,
    recipientAddress,
    direction,
    amount,
    asset,
  };
}

/**
 * The height each wallet's memos were read up to, so opening the inbox again
 * reads only newer transactions instead of building a view of every one. A
 * view service that has gone back (a resync from scratch) is read again whole.
 */
const SCANNED_KEY = 'penumbraMemoScanned';

const readScanned = async (walletId: string): Promise<bigint> => {
  try {
    const got = (await chrome.storage.local.get(SCANNED_KEY))[SCANNED_KEY] as
      | Record<string, string>
      | undefined;
    return BigInt(got?.[walletId] ?? 0);
  } catch {
    return 0n;
  }
};

const writeScanned = async (walletId: string, height: bigint) => {
  const got = ((await chrome.storage.local.get(SCANNED_KEY))[SCANNED_KEY] ?? {}) as Record<
    string,
    string
  >;
  await chrome.storage.local.set({ [SCANNED_KEY]: { ...got, [walletId]: String(height) } });
};

/** one read at a time per wallet: a second caller shares the first one's */
const inFlight = new Map<string, Promise<{ synced: number; total: number }>>();

/**
 * hook to fetch and sync penumbra memos
 */
export function usePenumbraMemos(walletId: string) {
  const messages = useStore(messagesSelector);
  const [syncProgress, setSyncProgress] = useState<{ current: number; total: number } | null>(null);

  const syncMemos = useMutation({
    mutationFn: () => {
      const running = inFlight.get(walletId);
      if (running) {
        return running;
      }
      const run = read().finally(() => inFlight.delete(walletId));
      inFlight.set(walletId, run);
      return run;
    },
  });

  const read = async () => {
    const extracted: ExtractedMemo[] = [];
    let count = 0;

    const synced = (await viewClient.status({})).fullSyncHeight;
    const from = await readScanned(walletId);
    // the view service starts over after a resync from scratch; so does this
    const startHeight = from > synced ? 0n : from;

    // only transactions the last read has not seen
    for await (const response of viewClient.transactionInfo({ startHeight })) {
      if (!response.txInfo) {
        continue;
      }

      count++;
      setSyncProgress({ current: count, total: count }); // we don't know total upfront

      // skip if we already have this message
      const txId = response.txInfo.id?.inner
        ? Array.from(response.txInfo.id.inner)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('')
        : '';

      if (messages.hasMessage(txId)) {
        continue;
      }

      const memo = extractMemoFromTransaction(response.txInfo);
      if (memo) {
        extracted.push(memo);
      }
    }

    // fetch real timestamps from SctService for unique heights
    if (extracted.length > 0) {
      const uniqueHeights = [...new Set(extracted.map(m => m.blockHeight))];
      const timestampMap = new Map<number, number>();

      await Promise.all(
        uniqueHeights.map(async height => {
          try {
            const { timestamp } = await sctClient.timestampByHeight({ height: BigInt(height) });
            if (timestamp) {
              timestampMap.set(height, timestamp.toDate().getTime());
            }
          } catch {
            // timestamp unavailable
          }
        }),
      );

      // update memos with real timestamps
      for (const memo of extracted) {
        memo.timestamp = timestampMap.get(memo.blockHeight) ?? memo.timestamp;
      }

      // add all new memos to messages store
      await messages.addMessages(
        extracted.map(m => ({
          network: 'penumbra' as const,
          senderAddress: m.senderAddress,
          recipientAddress: m.recipientAddress,
          content: m.content,
          txId: m.txId,
          blockHeight: m.blockHeight,
          timestamp: m.timestamp,
          direction: m.direction,
          read: false,
          amount: m.amount,
          asset: m.asset,
        })),
      );
    }

    await writeScanned(walletId, synced);
    setSyncProgress(null);
    return { synced: extracted.length, total: count };
  };

  return {
    syncMemos: syncMemos.mutate,
    isSyncing: syncMemos.isPending,
    syncProgress,
    syncResult: syncMemos.data,
    syncError: syncMemos.error,
  };
}

/**
 * hook to get unread memo count for badge
 */
export function usePenumbraUnreadCount() {
  const messages = useStore(messagesSelector);
  return messages.getByNetwork('penumbra').filter(m => !m.read && m.direction === 'received')
    .length;
}
