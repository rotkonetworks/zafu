import { useState, useEffect } from 'react';
import { ClockIcon, ReloadIcon, ArrowUpIcon, ArrowDownIcon } from '@radix-ui/react-icons';
import { useQuery } from '@tanstack/react-query';
import { viewClient, sctClient } from '../../../clients';
import { useStore } from '../../../state';
import { selectActiveNetwork } from '../../../state/keyring';
import { cn } from '@repo/ui/lib/utils';
import type { TransactionInfo } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';

interface ParsedTransaction {
  id: string;
  height: number;
  timestamp: number | null; // null until fetched from SctService
  type: 'send' | 'receive' | 'swap' | 'delegate' | 'undelegate' | 'unknown';
  description: string;
  amount?: string;
  asset?: string;
}

function parseTransaction(txInfo: TransactionInfo): ParsedTransaction {
  const id = txInfo.id?.inner
    ? Array.from(txInfo.id.inner)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
    : '';

  const height = Number(txInfo.height ?? 0);

  let type: ParsedTransaction['type'] = 'unknown';
  let description = 'Transaction';
  let hasVisibleSpend = false;
  let hasOutput = false;

  for (const action of txInfo.view?.bodyView?.actionViews ?? []) {
    const actionCase = action.actionView.case;

    if (actionCase === 'spend') {
      // only count VISIBLE spends (spends we can see = we funded this tx)
      if (action.actionView.value.spendView?.case === 'visible') {
        hasVisibleSpend = true;
      }
    } else if (actionCase === 'output') {
      hasOutput = true;
    } else if (actionCase === 'swap') {
      type = 'swap';
      description = 'Swap';
    } else if (actionCase === 'delegate') {
      type = 'delegate';
      description = 'Delegate';
    } else if (actionCase === 'undelegate') {
      type = 'undelegate';
      description = 'Undelegate';
    }
  }

  // determine send/receive based on visible spends
  // if we have visible spends, we funded this = we sent
  // if we only have outputs (no visible spends), we received
  if (type === 'unknown') {
    if (hasVisibleSpend) {
      type = 'send';
      description = 'Send';
    } else if (hasOutput) {
      type = 'receive';
      description = 'Receive';
    }
  }

  return { id, height, timestamp: null, type, description };
}

function formatTimestamp(ts: number | null): string {
  if (ts === null) return '...';
  const date = new Date(ts);
  const now = new Date();

  // Compare calendar days, not 24-hour periods
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
  const isIncoming = tx.type === 'receive';

  return (
    <div className='flex items-center gap-3 rounded-lg border border-border/30 bg-card p-3 hover:border-border transition-colors'>
      <div className={cn(
        'flex h-10 w-10 items-center justify-center rounded-full',
        isIncoming ? 'bg-green-500/10' : 'bg-muted/50'
      )}>
        {isIncoming ? (
          <ArrowDownIcon className='h-5 w-5 text-green-500' />
        ) : (
          <ArrowUpIcon className='h-5 w-5 text-muted-foreground' />
        )}
      </div>

      <div className='flex-1 min-w-0'>
        <div className='flex items-center justify-between gap-2'>
          <span className='text-sm font-medium'>{tx.description}</span>
          <span className='text-xs text-muted-foreground'>{formatTimestamp(tx.timestamp)}</span>
        </div>
        <p className='text-xs text-muted-foreground mt-0.5 font-mono truncate'>
          {tx.id.slice(0, 16)}...
        </p>
      </div>
    </div>
  );
}

export const HistoryPage = () => {
  const activeNetwork = useStore(selectActiveNetwork);
  const [transactions, setTransactions] = useState<ParsedTransaction[]>([]);

  const { isLoading, error, refetch } = useQuery({
    queryKey: ['transactionHistory', activeNetwork],
    enabled: activeNetwork === 'penumbra',
    staleTime: 30_000,
    queryFn: async () => {
      const txs: ParsedTransaction[] = [];

      for await (const response of viewClient.transactionInfo({})) {
        if (response.txInfo) {
          txs.push(parseTransaction(response.txInfo));
        }
      }

      // fetch real timestamps from SctService for unique heights
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
            // timestamp unavailable - will show "..."
          }
        })
      );

      // update transactions with real timestamps
      for (const tx of txs) {
        tx.timestamp = timestampMap.get(tx.height) ?? null;
      }

      // sort by height descending (newest first)
      txs.sort((a, b) => b.height - a.height);
      setTransactions(txs);
      return txs;
    },
  });

  // auto-fetch on mount for penumbra
  useEffect(() => {
    if (activeNetwork === 'penumbra') {
      void refetch();
    }
  }, [activeNetwork, refetch]);

  if (activeNetwork !== 'penumbra') {
    return (
      <div className='flex flex-col items-center justify-center gap-4 p-6 pt-16 text-center'>
        <div className='rounded-full bg-primary/10 p-4'>
          <ClockIcon className='h-8 w-8 text-primary' />
        </div>
        <div>
          <h2 className='text-lg font-semibold'>Transaction History</h2>
          <p className='mt-1 text-sm text-muted-foreground'>
            Transaction history is only available for Penumbra.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className='flex flex-col h-full'>
      {/* header */}
      <div className='flex items-center justify-between px-4 py-3 border-b border-border/40'>
        <h1 className='text-lg font-medium'>History</h1>
        <button
          onClick={() => void refetch()}
          disabled={isLoading}
          className='rounded-lg p-1.5 hover:bg-muted transition-colors disabled:opacity-50'
          title='refresh'
        >
          <ReloadIcon className={cn('h-4 w-4', isLoading && 'animate-spin')} />
        </button>
      </div>

      {/* content */}
      <div className='flex-1 overflow-y-auto p-4'>
        {isLoading && transactions.length === 0 ? (
          <div className='flex flex-col items-center justify-center gap-3 py-12 text-center'>
            <ReloadIcon className='h-6 w-6 animate-spin text-muted-foreground' />
            <p className='text-sm text-muted-foreground'>Loading transactions...</p>
          </div>
        ) : error ? (
          <div className='flex flex-col items-center justify-center gap-3 py-12 text-center'>
            <p className='text-sm text-red-400'>Failed to load transactions</p>
            <button
              onClick={() => void refetch()}
              className='text-xs text-primary hover:underline'
            >
              Try again
            </button>
          </div>
        ) : transactions.length === 0 ? (
          <div className='flex flex-col items-center justify-center gap-3 py-12 text-center'>
            <div className='rounded-full bg-primary/10 p-4'>
              <ClockIcon className='h-8 w-8 text-primary' />
            </div>
            <div>
              <p className='text-sm font-medium'>No transactions yet</p>
              <p className='text-xs text-muted-foreground'>
                Your transaction history will appear here
              </p>
            </div>
          </div>
        ) : (
          <div className='space-y-2'>
            {transactions.map(tx => (
              <TransactionRow key={tx.id} tx={tx} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
