import { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Sensitive } from '../../../components/sensitive';
import { viewClient, sctClient } from '../../../clients';
import { useStore } from '../../../state';
import {
  selectActiveNetwork,
  selectEffectiveKeyInfo,
  selectPenumbraAccount,
} from '../../../state/keyring';
import { getHistoryInWorker } from '../../../state/keyring/network-worker';
import { useTransparentAddresses } from '../../../hooks/use-transparent-addresses';
import { cn } from '@repo/ui/lib/utils';
import type { TransactionInfo } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import {
  classifyTransaction,
  getTransactionClassificationLabel,
} from '@penumbra-zone/perspective/transaction/classify';
import type { TransactionClassification } from '@penumbra-zone/perspective/transaction/classification';

interface ParsedTransaction {
  id: string;
  height: number;
  timestamp: number | null;
  type:
    | 'send'
    | 'receive'
    | 'shield'
    | 'unshield'
    | 'deposit'
    | 'swap'
    | 'delegate'
    | 'undelegate'
    | 'unknown';
  description: string;
  /**
   * Confirmation state. Absent means the source only ever reports settled
   * transactions (penumbra) and the row is treated as confirmed.
   */
  status?: 'pending' | 'confirmed' | 'failed';
  /**
   * `amount` is a ceiling, not a figure: the change coming back from this send
   * has not been scanned yet, so the true amount is at most this.
   */
  amountUpperBound?: boolean;
  amount?: string;
  asset?: string;
  /** penumbra account indices associated with this transaction (from visible actions) */
  accountIndices?: Set<number>;
}

/** extract account index from a visible note's decoded address view */
function noteAccountIndex(note: unknown): number | undefined {
  const n = note as
    | { address?: { addressView?: { case?: string; value?: { index?: { account?: number } } } } }
    | undefined;
  if (!n?.address?.addressView) {
    return undefined;
  }
  const av = n.address.addressView;
  if (av.case === 'decoded' && av.value?.index != null) {
    return av.value.index.account;
  }
  return undefined;
}

/** map the canonical perspective classification to zafu's display type */
const CLASSIFICATION_TO_TYPE: Partial<Record<TransactionClassification, ParsedTransaction['type']>> =
  {
    send: 'send',
    receive: 'receive',
    internalTransfer: 'send',
    ics20Withdrawal: 'unshield',
    ibcRelayAction: 'deposit',
    swap: 'swap',
    swapClaim: 'swap',
    delegate: 'delegate',
    undelegate: 'undelegate',
    undelegateClaim: 'undelegate',
  };

function parseTransaction(txInfo: TransactionInfo): ParsedTransaction {
  const id = txInfo.id?.inner
    ? Array.from(txInfo.id.inner)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
    : '';

  const height = Number(txInfo.height ?? 0);

  // account indices touched by this tx (zafu-specific, for per-account filtering)
  const accountIndices = new Set<number>();
  for (const action of txInfo.view?.bodyView?.actionViews ?? []) {
    const actionCase = action.actionView.case;
    if (actionCase === 'spend' && action.actionView.value.spendView?.case === 'visible') {
      const idx = noteAccountIndex(action.actionView.value.spendView.value?.note);
      if (idx != null) {
        accountIndices.add(idx);
      }
    } else if (actionCase === 'output') {
      const ov = action.actionView.value.outputView;
      if (ov?.case === 'visible') {
        const idx = noteAccountIndex(ov.value?.note);
        if (idx != null) {
          accountIndices.add(idx);
        }
      }
    }
  }

  // Canonical classification (perspective) instead of hand-rolling: correctly
  // separates send / receive / unshield (ics20Withdrawal) / deposit
  // (ibcRelayAction) / swap / (un)delegate. The old heuristic defaulted any
  // spend to 'send', so unshields showed as sends.
  const classification = classifyTransaction(txInfo.view).type;
  const type: ParsedTransaction['type'] = CLASSIFICATION_TO_TYPE[classification] ?? 'unknown';
  const description = getTransactionClassificationLabel(txInfo.view).toLowerCase();

  return { id, height, timestamp: null, type, description, accountIndices };
}

function zatoshiToZec(zatoshis: bigint | string): string {
  const val = typeof zatoshis === 'string' ? BigInt(zatoshis) : zatoshis;
  const whole = val / 100_000_000n;
  const frac = val % 100_000_000n;
  const fracStr = frac.toString().padStart(8, '0').replace(/0+$/, '') || '0';
  return `${whole}.${fracStr}`;
}

function formatTimestamp(ts: number | null): string {
  if (ts === null) {
    return '...';
  }
  const date = new Date(ts);
  const now = new Date();

  const dateDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.floor((today.getTime() - dateDay.getTime()) / (1000 * 60 * 60 * 24));

  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (diffDays === 0) {
    return `Today ${time}`;
  }
  if (diffDays === 1) {
    return `Yesterday ${time}`;
  }
  if (diffDays < 7) {
    const weekday = date.toLocaleDateString([], { weekday: 'short' });
    return `${weekday} ${time}`;
  }
  const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${dateStr} ${time}`;
}

function TransactionRow({ tx }: { tx: ParsedTransaction }) {
  // deposit (IBC in) lands funds like a receive; unshield/shield are pool moves
  const isIncoming = tx.type === 'receive' || tx.type === 'deposit';
  const isShield = tx.type === 'shield' || tx.type === 'unshield';
  const isPending = tx.status === 'pending';
  const isFailed = tx.status === 'failed';

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border bg-elev-1 p-3 hover:border-fg-muted/30 transition-colors',
        isFailed ? 'border-hanko/40' : 'border-border-soft',
        isPending && 'border-dashed',
      )}
    >
      <div
        className={cn(
          'flex h-10 w-10 items-center justify-center rounded-full',
          isPending || isFailed
            ? 'bg-elev-2'
            : isShield
              ? 'bg-blue-500/10'
              : isIncoming
                ? 'bg-green-500/10'
                : 'bg-elev-2',
        )}
      >
        {/* an unsettled transaction is described by its state, not its
            direction — the direction stops mattering until it lands */}
        {isPending ? (
          <span className='i-lucide-circle-dashed h-5 w-5 animate-pulse text-fg-dim' />
        ) : isFailed ? (
          <span className='i-lucide-x h-5 w-5 text-hanko' />
        ) : isShield ? (
          <span className='i-lucide-move-horizontal h-5 w-5 text-blue-500' />
        ) : isIncoming ? (
          <span className='i-lucide-arrow-down h-5 w-5 text-green-400' />
        ) : (
          <span className='i-lucide-arrow-up h-5 w-5 text-fg-muted' />
        )}
      </div>

      <div className='flex-1 min-w-0'>
        <div className='flex items-center justify-between gap-2'>
          <span
            className={cn(
              'text-sm font-medium',
              isPending && 'text-fg-muted',
              isFailed && 'text-hanko',
            )}
          >
            {tx.description}
          </span>
          {tx.amount && (
            <span
              className={cn(
                'text-sm font-mono',
                isFailed && 'text-fg-dim line-through',
                !isFailed && isShield && 'text-blue-500',
                !isFailed && !isShield && isIncoming && 'text-green-400',
                !isFailed && !isShield && !isIncoming && 'text-fg-muted',
              )}
            >
              {/* "at most": the change coming back has not been scanned, so
                  the real figure is below this. Better vague than overstated —
                  reporting gross inputs told users they had spent everything. */}
              {tx.amountUpperBound ? '≤ ' : isIncoming ? '+' : ''}
              <Sensitive>
                {tx.amount} {tx.asset ?? ''}
              </Sensitive>
            </span>
          )}
        </div>
        <div className='flex items-center justify-between gap-2 mt-0.5'>
          <p className='text-xs text-fg-muted font-mono truncate'>{tx.id.slice(0, 16)}...</p>
          {/* no height means no block to name — say what is actually known
              rather than printing a confident-looking `#0` */}
          <span
            className={cn(
              'text-xs whitespace-nowrap lowercase',
              isFailed ? 'text-hanko' : 'text-fg-muted',
            )}
          >
            {tx.height > 0
              ? `#${tx.height}`
              : isPending
                ? `${formatTimestamp(tx.timestamp)} · unconfirmed`
                : isFailed
                  ? 'expired'
                  : formatTimestamp(tx.timestamp)}
          </span>
        </div>
      </div>
    </div>
  );
}

export const HistoryPage = () => {
  const activeNetwork = useStore(selectActiveNetwork);
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const penumbraAccount = useStore(selectPenumbraAccount);
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const historyEnabled = useStore(s => s.privacy.settings.enableTransactionHistory);
  const [transactions, setTransactions] = useState<ParsedTransaction[]>([]);

  const walletId = selectedKeyInfo?.id;
  const isMainnet = !zidecarUrl.includes('testnet');
  const { tAddresses } = useTransparentAddresses(isMainnet);

  // penumbra history
  const penumbraQuery = useQuery({
    queryKey: ['transactionHistory', 'penumbra'],
    enabled: historyEnabled && activeNetwork === 'penumbra',
    staleTime: 30_000,
    queryFn: async () => {
      const txs: ParsedTransaction[] = [];

      for await (const response of viewClient.transactionInfo({})) {
        if (response.txInfo) {
          txs.push(parseTransaction(response.txInfo));
        }
      }

      const uniqueHeights = [...new Set(txs.map(tx => tx.height))];
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

      for (const tx of txs) {
        tx.timestamp = timestampMap.get(tx.height) ?? null;
      }

      txs.sort((a, b) => b.height - a.height);
      setTransactions(txs);
      return txs;
    },
  });

  // zcash history (shielded + transparent)
  const zcashQuery = useQuery({
    queryKey: ['transactionHistory', 'zcash', walletId, tAddresses.length],
    enabled: historyEnabled && activeNetwork === 'zcash' && !!walletId,
    staleTime: 0,
    queryFn: async () => {
      if (!walletId) {
        return [];
      }
      console.log('[history] fetching zcash history for wallet', walletId);

      const entries = await getHistoryInWorker('zcash', walletId, zidecarUrl, tAddresses);

      // the worker already returns these in display order — pending first,
      // then failed, then confirmed by height. Re-sorting here by height would
      // bury every heightless row at the bottom.
      const txs: ParsedTransaction[] = entries.map(e => ({
        id: e.id,
        height: e.height,
        timestamp: e.sentAt ?? null,
        type: e.type as ParsedTransaction['type'],
        // the verb must match the state: a broadcast we have not seen mined is
        // not "sent", and saying it is was the whole problem
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
        // what left the wallet (recipient + fee), not the notes spent as inputs
        amount: zatoshiToZec(BigInt(e.amount)),
        asset: e.asset,
        status: e.status,
        amountUpperBound: e.amountUpperBound,
      }));

      setTransactions(txs);
      return txs;
    },
  });

  // for penumbra, filter by the selected account index - a tx belongs to an
  // account if any of its visible spend or output notes reference that index
  const filteredTransactions = useMemo(() => {
    if (activeNetwork !== 'penumbra') {
      return transactions;
    }
    return transactions.filter(
      tx =>
        !tx.accountIndices ||
        tx.accountIndices.size === 0 ||
        tx.accountIndices.has(penumbraAccount),
    );
  }, [transactions, activeNetwork, penumbraAccount]);

  const isLoading = activeNetwork === 'penumbra' ? penumbraQuery.isLoading : zcashQuery.isLoading;
  const error = activeNetwork === 'penumbra' ? penumbraQuery.error : zcashQuery.error;
  const refetch = activeNetwork === 'penumbra' ? penumbraQuery.refetch : zcashQuery.refetch;

  useEffect(() => {
    void refetch();
  }, [activeNetwork, walletId, refetch]);

  // NOTE: keep this below every hook - an early return above a hook crashes
  // the component when the setting changes mid-session (hook-order violation)
  if (!historyEnabled) {
    return (
      <div className='flex flex-col h-full'>
        <div className='flex items-center px-4 py-3 border-b border-border-soft'>
          <h1 className='text-lg font-medium'>history</h1>
        </div>
        <div className='flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center'>
          <span className='i-lucide-eye-off h-8 w-8 text-fg-muted/30' />
          <p className='text-sm text-fg-muted'>transaction history is disabled</p>
          <p className='text-xs text-fg-muted/50'>
            enable in settings &rarr; privacy to see past transactions
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className='flex flex-col h-full'>
      {/* header */}
      <div className='flex items-center justify-between px-4 py-3 border-b border-border-soft'>
        <h1 className='text-lg font-medium'>history</h1>
        <button
          onClick={() => void refetch()}
          disabled={isLoading}
          className='rounded-lg p-1.5 hover:bg-elev-1 transition-colors disabled:opacity-50'
          title='refresh'
        >
          <span className={cn('i-lucide-refresh-cw h-4 w-4', isLoading && 'animate-spin')} />
        </button>
      </div>

      {/* content */}
      <div className='flex-1 overflow-y-auto p-4'>
        {isLoading && filteredTransactions.length === 0 ? (
          // Skeleton of plausible tx-row geometry — same vertical rhythm as
          // a real list of transactions, no spinner. Disappears once the
          // first transactions resolve.
          <div className='flex flex-col gap-2 animate-pulse'>
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className='flex items-start gap-3 rounded-md bg-elev-1 p-3'>
                <div className='h-8 w-8 shrink-0 rounded-full bg-elev-2/60' />
                <div className='flex-1 space-y-1.5'>
                  <div className='h-3 w-2/3 rounded-sm bg-elev-2/60' />
                  <div className='h-2 w-1/3 rounded-sm bg-elev-2/40' />
                </div>
                <div className='h-3 w-16 rounded-sm bg-elev-2/40' />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className='flex flex-col items-center justify-center gap-3 py-12 text-center'>
            <p className='text-sm text-red-400'>failed to load transactions</p>
            <button
              onClick={() => void refetch()}
              className='text-xs text-zigner-gold hover:underline'
            >
              try again
            </button>
          </div>
        ) : filteredTransactions.length === 0 ? (
          <div className='flex flex-col items-center justify-center gap-3 py-12 text-center'>
            <div className='rounded-full bg-primary/10 p-4'>
              <span className='i-lucide-clock h-8 w-8 text-zigner-gold' />
            </div>
            <div>
              <p className='text-sm font-medium'>no transactions yet</p>
              <p className='text-xs text-fg-muted'>your transaction history will appear here</p>
            </div>
          </div>
        ) : (
          <div className='space-y-2'>
            {filteredTransactions.map(tx => (
              <TransactionRow key={tx.id} tx={tx} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
