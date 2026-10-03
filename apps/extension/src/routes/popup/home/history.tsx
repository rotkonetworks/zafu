import { useMemo, useRef, useEffect } from 'react';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { useStore } from '../../../state';
import type { NetworkType } from '../../../state/keyring';
import { activeZcashStoreId } from '../../../state/pockets';
import { messagesSelector } from '../../../state/messages';
import { privacySelector } from '../../../state/privacy';
import { useTransparentAddresses } from '../../../hooks/use-transparent-addresses';
import { useZcashSyncStatus } from '../../../hooks/zcash-sync';
import { useSyncProgress } from '../../../hooks/full-sync-height';
import { getRootNetwork, getNetwork } from '../../../config/networks';
import { viewClient, sctClient } from '../../../clients';
import { getHistoryInWorker } from '../../../state/keyring/network-worker';
import { zatToZec } from './format';
import { describePenumbraHistory } from '../../../history/penumbra-describe';
import { isIncoming, penumbraRow, type ParsedTransaction } from './tx-parse';
import { TxRow } from './tx-row';
import { PopupPath } from '../paths';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { Button } from '@repo/ui/components/ui/button';

/**
 * The first-payment "keep a history on this computer?" ask, asked once and
 * shared by every network's home screen (`enableTransactionHistory` gates
 * {@link HistoryContent} for all of them, not just zcash). A network's home
 * passes `hasFunds` the moment it has something worth asking about - zcash's
 * total balance, penumbra's UM total - so each screen decides its own
 * trigger without duplicating the sheet or the privacy-setting writes.
 */
export const AskHistorySheet = ({ hasFunds }: { hasFunds: boolean }) => {
  const { settings, setSetting } = useStore(privacySelector);
  const ask = hasFunds && !settings.enableTransactionHistory && !settings.historyAsked;
  const answer = (keep: boolean) => {
    void setSetting('historyAsked', true);
    if (keep) {
      void setSetting('enableTransactionHistory', true);
    }
  };
  return (
    <Sheet
      open={ask}
      onOpenChange={open => !open && answer(false)}
      title='your first payment arrived.'
    >
      <div className='flex flex-col gap-3'>
        <p className='-mt-6 mb-1.5 font-display text-xl text-fg-high'>
          keep a history on this computer?
        </p>
        <Button onClick={() => answer(true)}>keep history</Button>
        <Button variant='secondary' onClick={() => answer(false)}>
          show only balance
        </Button>
        <span className='text-[11px] text-fg-dim'>
          asked once · change it in settings › privacy
        </span>
      </div>
    </Sheet>
  );
};

/**
 * Penumbra's history from the local view service, as the query home's section,
 * activity and their intent preloads share.
 */
export const penumbraHistoryQuery = (account: number, enabled: boolean) =>
  queryOptions({
    queryKey: ['homeHistory', 'penumbra', account],
    enabled,
    staleTime: 10_000,
    queryFn: async (): Promise<ParsedTransaction[]> => {
      const infos = [];
      for await (const r of viewClient.transactionInfo({})) {
        if (r.txInfo) {
          infos.push(r.txInfo);
        }
      }
      const txs = describePenumbraHistory(infos).map(penumbraRow);
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
      return txs;
    },
  });

/** a zcash pocket's history from the worker, keyed as home's section and activity read it */
export const zcashHistoryQuery = (
  storeId: string | undefined,
  zidecarUrl: string,
  tAddresses: string[],
  enabled: boolean,
) =>
  queryOptions({
    queryKey: ['homeHistory', 'zcash', storeId, tAddresses.length],
    enabled: enabled && !!storeId,
    staleTime: 10_000,
    queryFn: async (): Promise<ParsedTransaction[]> => {
      const entries = await getHistoryInWorker('zcash', storeId!, zidecarUrl, tAddresses);
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
        // one (merged in at render) is only ever recoverable for incoming notes
        memo: e.memo,
        status: e.status,
        amountUpperBound: e.amountUpperBound,
        recipientAmount: e.recipientAmount ? zatToZec(BigInt(e.recipientAmount)) : undefined,
        feeAmount: e.fee ? zatToZec(BigInt(e.fee)) : undefined,
        recipient: e.recipient,
        sentAt: e.sentAt,
      }));
    },
  });

/**
 * Transaction history. Fetched only after the user chose to keep it
 * (`enableTransactionHistory`, asked once on the first payment); off means
 * nothing is queried and nothing renders. With `limit`, the home section:
 * the newest few and "see all".
 */
export const HistoryContent = ({
  network,
  penumbraAccount,
  limit,
  filter = 'all',
}: {
  network: NetworkType;
  penumbraAccount: number;
  limit?: number;
  /** client-side split of the already-fetched list; no new request per tab */
  filter?: 'all' | 'sent' | 'received';
}) => {
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const historyEnabled = useStore(s => s.privacy.settings.enableTransactionHistory);
  const messages = useStore(messagesSelector);
  // the active pocket's own store: account 0 is the bare wallet id
  const zcashStoreId = useStore(activeZcashStoreId);
  const isMainnet = !zidecarUrl.includes('testnet');
  const { tAddresses } = useTransparentAddresses(isMainnet);
  const { workerSyncHeight } = useZcashSyncStatus();
  const latestBlockHeight = useSyncProgress().tip;
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

  // hooks must always be called in the same order - queries use `enabled` flag instead
  const penumbraQ = useQuery(
    penumbraHistoryQuery(penumbraAccount, getRootNetwork(network) === 'penumbra' && historyEnabled),
  );
  const zcashQ = useQuery(
    zcashHistoryQuery(zcashStoreId, zidecarUrl, tAddresses, network === 'zcash' && historyEnabled),
  );

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
    return null;
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
  const allTxs = (q.data ?? []).map(tx =>
    network !== 'zcash' || tx.memo != null ? tx : { ...tx, memo: memoByTxId.get(tx.id) },
  );
  const byAccount =
    network === 'penumbra'
      ? allTxs.filter(
          tx =>
            !tx.accountIndices ||
            tx.accountIndices.size === 0 ||
            tx.accountIndices.has(penumbraAccount),
        )
      : allTxs;
  const txs =
    filter === 'all'
      ? byAccount
      : byAccount.filter(tx => isIncoming(tx) === (filter === 'received'));

  if (q.error) {
    return (
      <div className='flex items-center justify-center gap-2 py-4 text-xs'>
        <span className='text-fg-muted'>activity did not load</span>
        <button onClick={() => void q.refetch()} className='text-zigner-gold hover:underline'>
          try again
        </button>
      </div>
    );
  }

  if (txs.length === 0) {
    return limit || q.isLoading ? null : (
      <span className='py-6 text-center text-xs text-fg-muted'>nothing here yet</span>
    );
  }

  const shown = limit ? txs.slice(0, limit) : txs;
  return (
    <section className='flex flex-col gap-2'>
      {limit && (
        <div className='flex h-[18px] items-center justify-between'>
          <h2 className='text-xs tracking-[0.04em] text-fg-muted'>activity</h2>
          <Link
            to={PopupPath.ACTIVITY}
            data-preload={PopupPath.ACTIVITY}
            className='text-xs text-network-accent'
          >
            see all
          </Link>
        </div>
      )}
      <div className='flex flex-col'>
        {shown.map(tx => (
          <TxRow key={tx.id} tx={tx} network={network} />
        ))}
      </div>
    </section>
  );
};
