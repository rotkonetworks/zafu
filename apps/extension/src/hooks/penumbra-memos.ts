/**
 * hook to sync penumbra transaction memos into the inbox
 *
 * extracts memos from transaction history and adds them to messages store
 */

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { viewClient } from '../clients';
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

  // determine direction by checking action types
  // if we have OutputView actions, we likely sent this
  // if we have SpendView actions with notes to us, we received it
  let direction: 'sent' | 'received' = 'received';
  let recipientAddress = '';
  let amount: string | undefined;
  let asset: string | undefined;

  for (const action of view.bodyView?.actionViews ?? []) {
    if (action.actionView.case === 'output') {
      // we sent to someone
      direction = 'sent';
      const output = action.actionView.value;
      if (output.outputView?.case === 'visible') {
        const note = output.outputView.value.note;
        if (note?.address) {
          try {
            const address = getAddressFromView(note.address);
            if (address) {
              recipientAddress = bech32mAddress(address);
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
    } else if (action.actionView.case === 'spend') {
      // check if this is our spend (we received)
      const spend = action.actionView.value;
      if (spend.spendView?.case === 'visible') {
        const note = spend.spendView.value.note;
        if (note?.address) {
          try {
            const address = getAddressFromView(note.address);
            if (address) {
              recipientAddress = bech32mAddress(address);
            }
          } catch {
            // invalid
          }
        }
      }
    }
  }

  // estimate timestamp from block height (roughly 5 seconds per block)
  const blockHeight = Number(txInfo.height ?? 0);
  const genesisTime = 1700000000000; // approximate penumbra genesis
  const timestamp = genesisTime + blockHeight * 5000;

  return {
    txId,
    blockHeight,
    timestamp,
    content: plaintext.text,
    senderAddress,
    recipientAddress,
    direction,
    amount,
    asset,
  };
}

/**
 * hook to fetch and sync penumbra memos
 */
export function usePenumbraMemos() {
  const messages = useStore(messagesSelector);
  const [syncProgress, setSyncProgress] = useState<{ current: number; total: number } | null>(null);

  const syncMemos = useMutation({
    mutationFn: async () => {
      const extracted: ExtractedMemo[] = [];
      let count = 0;

      // stream all transactions
      for await (const response of viewClient.transactionInfo({})) {
        if (!response.txInfo) continue;

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

      // add all new memos to messages store
      if (extracted.length > 0) {
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
          }))
        );
      }

      setSyncProgress(null);
      return { synced: extracted.length, total: count };
    },
  });

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
  return messages.getByNetwork('penumbra').filter(m => !m.read && m.direction === 'received').length;
}
