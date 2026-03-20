/**
 * hook to sync zcash transaction memos into the inbox
 *
 * all heavy lifting (bucket fetch, noise generation, decryption) runs in the
 * zcash worker — this hook is a thin wrapper that sends one message and
 * inserts returned memos into the zustand messages store.
 */

import { useState, useEffect } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useStore } from '../state';
import { messagesSelector } from '../state/messages';
import {
  syncMemosInWorker,
  decryptMemosInWorker,
  type FoundNoteWithMemo,
} from '../state/keyring/network-worker';
import {
  isStructuredMemo,
  decodeMemo,
  decodeContactCard,
  MemoType,
} from '@repo/wallet/networks/zcash/memo-codec';

const DEFAULT_ZIDECAR_URL = 'https://zcash.rotko.net';

/**
 * Parse a Zcash memo for an embedded return address.
 *
 * Convention: the last line of the memo may be `reply:<address>` where
 * <address> is a unified (u1...) or Sapling (zs1...) address. If found,
 * the return address is extracted and stripped from the displayed content.
 */
function parseReturnAddress(raw: string): { content: string; returnAddress?: string } {
  const lines = raw.trimEnd().split('\n');
  const last = lines[lines.length - 1]?.trim() ?? '';
  const match = last.match(/^reply:(u1[a-z0-9]+|zs1[a-z0-9]+)$/i);
  if (match) {
    return {
      content: lines.slice(0, -1).join('\n').trimEnd(),
      returnAddress: match[1],
    };
  }
  return { content: raw };
}

interface MemoSyncResult {
  synced: number;
}

/**
 * hook to fetch and sync zcash memos
 *
 * privacy-preserving bucket chunking + noise runs entirely in worker
 */
export function useZcashMemos(walletId: string, zidecarUrl: string = DEFAULT_ZIDECAR_URL) {
  const messages = useStore(messagesSelector);
  const [syncProgress, setSyncProgress] = useState<{ current: number; total: number } | null>(null);

  // listen for progress events from worker
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.current !== undefined && detail?.total !== undefined) {
        setSyncProgress({ current: detail.current, total: detail.total });
      }
    };
    window.addEventListener('zcash-memo-sync-progress', handler);
    return () => window.removeEventListener('zcash-memo-sync-progress', handler);
  }, []);

  const syncMemos = useMutation({
    mutationFn: async (): Promise<MemoSyncResult> => {
      // gather existing txIds so worker knows what to skip
      let existingMessages = messages.getByNetwork('zcash');
      const existingTxIds = existingMessages.map(m => m.txId);

      // one-time migration: clear messages with bad timestamps so they resync
      // with real block times from the server
      const now = Date.now();
      const hasBadTimestamps = existingMessages.some(
        m => m.timestamp < 1700000000000 || m.timestamp > now + 86400000
      );
      if (hasBadTimestamps) {
        for (const msg of existingMessages) {
          await messages.deleteMessage(msg.id);
        }
        existingTxIds.length = 0;
        existingMessages = [];
      }

      // only force resync after migration cleared messages (not for memo-less wallets)
      const forceResync = hasBadTimestamps;

      setSyncProgress({ current: 0, total: 1 });

      const results = await syncMemosInWorker('zcash', walletId, zidecarUrl, existingTxIds, forceResync);

      // insert returned memos into zustand store
      for (const memo of results) {
        const { content, returnAddress } = parseReturnAddress(memo.content);
        await messages.addMessage({
          network: 'zcash',
          txId: memo.txId,
          blockHeight: memo.blockHeight,
          timestamp: memo.timestamp,
          content,
          senderAddress: returnAddress,
          recipientAddress: '',
          direction: memo.direction as 'sent' | 'received',
          read: memo.direction === 'sent',
          amount: memo.amount,
        });
      }

      // also feed raw memo bytes into the structured inbox for binary-encoded messages
      // (FROST coordination, fragmented text, address shares, etc.)
      // the existing messages store handles plain-text memos; the inbox handles structured ones
      if (results.length > 0) {
        const inbox = useStore.getState().inbox;
        const structuredNotes = results
          .filter(m => m.memoBytes)
          .map(m => {
            // decode hex to Uint8Array
            const hex = m.memoBytes!;
            const bytes = new Uint8Array(hex.length / 2);
            for (let i = 0; i < bytes.length; i++) {
              bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
            }
            return bytes;
          })
          .filter(bytes => isStructuredMemo(bytes))
          .map((bytes, i) => {
            const m = results.filter(r => r.memoBytes)[i]!;
            return {
              txid: m.txId,
              height: m.blockHeight,
              memo: bytes,
              diversifierIndex: m.diversifierIndex ?? 0,
              isChange: m.direction === 'sent',
              timestamp: m.timestamp,
            };
          });
        if (structuredNotes.length > 0) {
          inbox.ingestMemos(structuredNotes);
        }

        // surface contact cards as messages so they appear in the inbox UI
        for (const note of structuredNotes) {
          const parsed = decodeMemo(note.memo);
          if (!parsed || parsed.type !== MemoType.ContactCard) continue;

          const card = decodeContactCard(parsed.payload);
          if (!card) continue;

          const m = results.find(r => r.txId === note.txid);
          if (!m) continue;

          // store as a message with a recognizable prefix for the UI to detect
          await messages.addMessage({
            network: 'zcash',
            txId: m.txId,
            blockHeight: m.blockHeight,
            timestamp: m.timestamp,
            content: `📇 ${card.name || 'anonymous'}\n${card.address}`,
            senderAddress: card.address,
            recipientAddress: '',
            direction: m.direction as 'sent' | 'received',
            read: m.direction === 'sent',
            amount: m.amount,
            asset: 'contact-card', // tag for UI detection
          });
        }
      }

      setSyncProgress(null);
      return { synced: results.length };
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
 * hook to get unread zcash memo count for badge
 */
export function useZcashUnreadCount() {
  const messages = useStore(messagesSelector);
  return messages.getByNetwork('zcash').filter(m => !m.read && m.direction === 'received').length;
}

/**
 * decrypt memos from a single transaction (standalone function)
 */
export async function decryptTransactionMemos(
  walletId: string,
  txBytes: Uint8Array
): Promise<FoundNoteWithMemo[]> {
  try {
    return await decryptMemosInWorker('zcash', walletId, txBytes);
  } catch (err) {
    console.error('failed to decrypt transaction memos:', err);
    return [];
  }
}
