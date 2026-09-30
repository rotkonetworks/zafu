import { useMemo, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useStore } from '../../../state';
import { selectEffectiveKeyInfo, type NetworkType } from '../../../state/keyring';
import { messagesSelector } from '../../../state/messages';
import { useTransparentAddresses } from '../../../hooks/use-transparent-addresses';
import { useZcashSyncStatus } from '../../../hooks/zcash-sync';
import { useSyncProgress } from '../../../hooks/full-sync-height';
import { getRootNetwork, getNetwork } from '../../../config/networks';
import { viewClient, sctClient } from '../../../clients';
import { getHistoryInWorker } from '../../../state/keyring/network-worker';
import { zatToZec } from './format';
import { parsePenumbraTx, type ParsedTransaction } from './tx-parse';
import { TxRow } from './tx-row';

export const HistoryContent = ({
  network,
  penumbraAccount,
}: {
  network: NetworkType;
  penumbraAccount: number;
}) => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const historyEnabled = useStore(s => s.privacy.settings.enableTransactionHistory);
  const messages = useStore(messagesSelector);
  const walletId = selectedKeyInfo?.id;
  const isMainnet = !zidecarUrl.includes('testnet');
  const { tAddresses } = useTransparentAddresses(isMainnet);
  const { workerSyncHeight } = useZcashSyncStatus();
  const { latestBlockHeight } = useSyncProgress();
  const queryClient = useQueryClient();

  // build txId→memo lookup from messages store (for zcash)
  const memoByTxId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of messages.getByNetwork(network as 'zcash' | 'penumbra')) {
      if (m.content) {
        map.set(m.txId, m.content);
      }
    }
    return map;
  }, [messages, network]);

  const setSetting = useStore(s => s.privacy.setSetting);

  // hooks must always be called in the same order - queries use `enabled` flag instead
  const penumbraQ = useQuery({
    queryKey: ['homeHistory', 'penumbra', penumbraAccount],
    enabled: getRootNetwork(network) === 'penumbra' && historyEnabled,
    staleTime: 10_000,
    queryFn: async () => {
      const txs: ParsedTransaction[] = [];
      for await (const r of viewClient.transactionInfo({})) {
        if (r.txInfo) {
          txs.push(parsePenumbraTx(r.txInfo));
        }
      }
      const heights = [...new Set(txs.map(t => t.height))];
      const tsMap = new Map<number, number>();
      await Promise.all(
        heights.map(async h => {
          try {
            const { timestamp } = await sctClient.timestampByHeight({ height: BigInt(h) });
            if (timestamp) {
              tsMap.set(h, timestamp.toDate().getTime());
            }
          } catch {
            /* */
          }
        }),
      );
      for (const t of txs) {
        t.timestamp = tsMap.get(t.height) ?? null;
      }
      txs.sort((a, b) => b.height - a.height);
      return txs;
    },
  });

  const zcashQ = useQuery({
    queryKey: ['homeHistory', 'zcash', walletId, tAddresses.length],
    enabled: network === 'zcash' && !!walletId && historyEnabled,
    staleTime: 10_000,
    queryFn: async () => {
      if (!walletId) {
        return [];
      }
      const entries = await getHistoryInWorker('zcash', walletId, zidecarUrl, tAddresses);
      return entries.map(e => ({
        id: e.id,
        height: e.height,
        // a pending row has no block and therefore no block time; its broadcast
        // time is the only honest thing to date it by
        timestamp: e.sentAt ?? null,
        type: e.type as ParsedTransaction['type'],
        // The verb has to match the state. "sent" for something that may never
        // confirm is the overstatement that started all this.
        description:
          e.status === 'pending'
            ? e.kind === 'migrate'
              ? 'migrating'
              : e.kind === 'shield'
                ? 'shielding'
                : 'sending'
            : e.status === 'failed'
              ? 'did not confirm'
              : e.kind === 'migrate'
                ? 'migrated'
                : e.type === 'send'
                  ? 'sent'
                  : e.type === 'shield'
                    ? 'shielded'
                    : 'received',
        amount: zatToZec(BigInt(e.amount)),
        asset: e.asset,
        // our own record's memo is what the user actually typed; the scanned
        // one is only ever recoverable for incoming notes
        memo: e.memo ?? memoByTxId.get(e.id),
        status: e.status,
        amountUpperBound: e.amountUpperBound,
        recipientAmount: e.recipientAmount ? zatToZec(BigInt(e.recipientAmount)) : undefined,
        feeAmount: e.fee ? zatToZec(BigInt(e.fee)) : undefined,
        recipient: e.recipient,
        sentAt: e.sentAt,
      }));
    },
  });

  // refetch history when block heights advance (live update, no flicker)
  const prevPenumbraHeight = useRef(latestBlockHeight);
  const prevZcashHeight = useRef(workerSyncHeight);
  useEffect(() => {
    if (
      network === 'penumbra' &&
      latestBlockHeight &&
      latestBlockHeight !== prevPenumbraHeight.current
    ) {
      prevPenumbraHeight.current = latestBlockHeight;
      void queryClient.invalidateQueries({ queryKey: ['homeHistory', 'penumbra'] });
    }
    if (network === 'zcash' && workerSyncHeight && workerSyncHeight !== prevZcashHeight.current) {
      prevZcashHeight.current = workerSyncHeight;
      void queryClient.invalidateQueries({ queryKey: ['homeHistory', 'zcash'] });
    }
  }, [network, latestBlockHeight, workerSyncHeight, queryClient]);

  if (!historyEnabled) {
    return (
      <div className='flex items-center justify-center gap-2 px-4 py-4 text-label lowercase'>
        <span className='text-fg-muted/50'>history off</span>
        <span className='text-fg-muted/30'>·</span>
        <button
          onClick={() => void setSetting('enableTransactionHistory', true)}
          className='text-zigner-gold/70 transition-colors hover:text-zigner-gold'
        >
          enable
        </button>
      </div>
    );
  }

  // Cosmos subnetworks (e.g. Noble) have their own transparent-chain activity,
  // which we do not index yet. Show a neutral empty state rather than the
  // parent's (Penumbra) or zcash transactions.
  if (getRootNetwork(network) !== network) {
    return (
      <div className='flex items-center justify-center px-4 py-6 text-label lowercase text-fg-muted/60'>
        history for {getNetwork(network).name} isn&apos;t available yet
      </div>
    );
  }

  const q = network === 'zcash' ? zcashQ : penumbraQ;
  // for penumbra, filter by the selected account index - a tx belongs to an
  // account if any of its visible spend or output notes reference that index
  const allTxs = (q.data ?? []) as ParsedTransaction[];
  const txs =
    network === 'penumbra'
      ? allTxs.filter(
          tx =>
            !tx.accountIndices ||
            tx.accountIndices.size === 0 ||
            tx.accountIndices.has(penumbraAccount),
        )
      : allTxs;

  if (q.isLoading && txs.length === 0) {
    return (
      <div className='flex flex-col items-center justify-center gap-3 py-12'>
        <span className='i-ph-arrows-clockwise h-5 w-5 animate-spin text-fg-muted' />
        <span className='text-xs text-fg-muted'>loading...</span>
      </div>
    );
  }

  if (q.error) {
    return (
      <div className='flex flex-col items-center justify-center gap-3 py-12'>
        <span className='text-xs text-red-400'>failed to load</span>
        <button
          onClick={() => void q.refetch()}
          className='text-xs text-zigner-gold hover:underline'
        >
          retry
        </button>
      </div>
    );
  }

  if (txs.length === 0) {
    return (
      <div className='flex flex-col items-center justify-center gap-3 py-12'>
        <span className='i-ph-clock h-5 w-5 text-fg-muted' />
        <span className='text-xs text-fg-muted'>no transactions yet</span>
      </div>
    );
  }

  const recent = txs.slice(0, 20);

  return (
    <div className='flex flex-col gap-1'>
      <div className='mb-1'>
        <span className='kicker'>recent activity</span>
      </div>
      {recent.map(tx => (
        <TxRow key={tx.id} tx={tx} network={network} />
      ))}
      {txs.length > 20 && (
        <div className='py-2 text-center text-xs text-fg-muted'>
          {txs.length - 20} more transactions
        </div>
      )}
    </div>
  );
};

