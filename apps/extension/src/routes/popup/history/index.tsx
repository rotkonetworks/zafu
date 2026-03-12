import { useState, useEffect } from 'react';
import { ClockIcon, ReloadIcon, ArrowUpIcon, ArrowDownIcon, WidthIcon } from '@radix-ui/react-icons';
import { useQuery } from '@tanstack/react-query';
import { viewClient, sctClient } from '../../../clients';
import { useStore } from '../../../state';
import { selectActiveNetwork, selectEffectiveKeyInfo } from '../../../state/keyring';
import { selectActiveZcashWallet } from '../../../state/wallets';
import { getNotesInWorker, getTransparentHistoryInWorker } from '../../../state/keyring/network-worker';
import { deriveZcashTransparent, deriveZcashTransparentFromUfvk } from '../../../hooks/use-address';
import { cn } from '@repo/ui/lib/utils';
import type { TransactionInfo } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';

interface ParsedTransaction {
  id: string;
  height: number;
  timestamp: number | null;
  type: 'send' | 'receive' | 'shield' | 'swap' | 'delegate' | 'undelegate' | 'unknown';
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

function zatoshiToZec(zatoshis: bigint | string): string {
  const val = typeof zatoshis === 'string' ? BigInt(zatoshis) : zatoshis;
  const whole = val / 100_000_000n;
  const frac = val % 100_000_000n;
  const fracStr = frac.toString().padStart(8, '0').replace(/0+$/, '') || '0';
  return `${whole}.${fracStr}`;
}

function formatTimestamp(ts: number | null): string {
  if (ts === null) return '...';
  const date = new Date(ts);
  const now = new Date();

  const dateDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.floor((today.getTime() - dateDay.getTime()) / (1000 * 60 * 60 * 24));

  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (diffDays === 0) return `Today ${time}`;
  if (diffDays === 1) return `Yesterday ${time}`;
  if (diffDays < 7) {
    const weekday = date.toLocaleDateString([], { weekday: 'short' });
    return `${weekday} ${time}`;
  }
  const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${dateStr} ${time}`;
}

function TransactionRow({ tx }: { tx: ParsedTransaction }) {
  const isIncoming = tx.type === 'receive';
  const isShield = tx.type === 'shield';

  return (
    <div className='flex items-center gap-3 rounded-lg border border-border/30 bg-card p-3 hover:border-border transition-colors'>
      <div className={cn(
        'flex h-10 w-10 items-center justify-center rounded-full',
        isShield ? 'bg-blue-500/10' : isIncoming ? 'bg-green-500/10' : 'bg-muted/50'
      )}>
        {isShield ? (
          <WidthIcon className='h-5 w-5 text-blue-500' />
        ) : isIncoming ? (
          <ArrowDownIcon className='h-5 w-5 text-green-500' />
        ) : (
          <ArrowUpIcon className='h-5 w-5 text-muted-foreground' />
        )}
      </div>

      <div className='flex-1 min-w-0'>
        <div className='flex items-center justify-between gap-2'>
          <span className='text-sm font-medium'>{tx.description}</span>
          {tx.amount && (
            <span className={cn('text-sm font-mono',
              isShield ? 'text-blue-500' : isIncoming ? 'text-green-500' : 'text-muted-foreground'
            )}>
              {isIncoming ? '+' : ''}{tx.amount} {tx.asset ?? ''}
            </span>
          )}
        </div>
        <div className='flex items-center justify-between gap-2 mt-0.5'>
          <p className='text-xs text-muted-foreground font-mono truncate'>
            {tx.id.slice(0, 16)}...
          </p>
          <span className='text-xs text-muted-foreground whitespace-nowrap'>
            {tx.height > 0 ? `#${tx.height}` : formatTimestamp(tx.timestamp)}
          </span>
        </div>
      </div>
    </div>
  );
}

export const HistoryPage = () => {
  const activeNetwork = useStore(selectActiveNetwork);
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const getMnemonic = useStore(s => s.keyRing.getMnemonic);
  const watchOnly = useStore(selectActiveZcashWallet);
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const [transactions, setTransactions] = useState<ParsedTransaction[]>([]);
  const [tAddresses, setTAddresses] = useState<string[]>([]);

  const walletId = selectedKeyInfo?.id;
  const isMnemonic = selectedKeyInfo?.type === 'mnemonic';
  const isMainnet = !zidecarUrl.includes('testnet');

  // derive transparent addresses for history lookup
  useEffect(() => {
    if (activeNetwork !== 'zcash' || !selectedKeyInfo) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await chrome.storage.local.get('zcashTransparentIndex');
        const storedIdx = r['zcashTransparentIndex'] ?? 0;
        const maxIdx = Math.max(4, storedIdx);
        const indices = Array.from({ length: maxIdx + 1 }, (_, i) => i);

        if (isMnemonic) {
          const mnemonic = await getMnemonic(selectedKeyInfo.id);
          const addrs = await Promise.all(indices.map(i => deriveZcashTransparent(mnemonic, 0, i, isMainnet)));
          if (!cancelled) setTAddresses(addrs);
        } else if (watchOnly) {
          const ufvk = watchOnly.ufvk ?? (watchOnly.orchardFvk?.startsWith('uview') ? watchOnly.orchardFvk : undefined);
          if (!ufvk) return;
          try {
            const addrs = await Promise.all(indices.map(i => deriveZcashTransparentFromUfvk(ufvk, i)));
            if (!cancelled) setTAddresses(addrs);
          } catch { /* UFVK may lack transparent component */ }
        }
      } catch (err) {
        console.error('[history] failed to derive t-addrs:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [activeNetwork, isMnemonic, selectedKeyInfo?.id, isMainnet, getMnemonic, watchOnly?.ufvk, watchOnly?.orchardFvk]);

  // penumbra history
  const penumbraQuery = useQuery({
    queryKey: ['transactionHistory', 'penumbra'],
    enabled: activeNetwork === 'penumbra',
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
        })
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
    enabled: activeNetwork === 'zcash' && !!walletId,
    staleTime: 0,
    queryFn: async () => {
      if (!walletId) return [];
      console.log('[history] fetching zcash notes for wallet', walletId);

      // fetch shielded notes + transparent history in parallel
      const [notes, tHistory] = await Promise.all([
        getNotesInWorker('zcash', walletId),
        tAddresses.length > 0
          ? getTransparentHistoryInWorker('zcash', zidecarUrl, tAddresses).catch(e => {
              console.warn('[history] transparent history failed:', e);
              return [];
            })
          : Promise.resolve([]),
      ]);
      console.log('[history] got', notes.length, 'notes,', tHistory.length, 'transparent txs');

      // build maps for sent amount calculation:
      // 1. txMap: group notes belonging to each txid (change notes from sends, received notes)
      // 2. spentByMap: notes indexed by spent_by_txid (input notes consumed by a send)
      const txMap = new Map<string, { height: number; position: number; changeValue: bigint; receiveValue: bigint; isChange: boolean }>();
      const spentByMap = new Map<string, bigint>(); // spent_by_txid → total input value

      for (const note of notes) {
        // track input values: if this note was spent by another tx, accumulate its value
        if (note.spent && note.spent_by_txid) {
          const prev = spentByMap.get(note.spent_by_txid) ?? 0n;
          spentByMap.set(note.spent_by_txid, prev + BigInt(note.value));
        }

        // group notes by the txid they appear in
        const existing = txMap.get(note.txid);
        if (existing) {
          existing.position = Math.max(existing.position, note.position ?? 0);
          if (note.is_change) {
            existing.isChange = true;
            existing.changeValue += BigInt(note.value);
          } else {
            existing.receiveValue += BigInt(note.value);
          }
        } else {
          txMap.set(note.txid, {
            height: note.height ?? 0,
            position: note.position ?? 0,
            changeValue: note.is_change ? BigInt(note.value) : 0n,
            receiveValue: note.is_change ? 0n : BigInt(note.value),
            isChange: !!note.is_change,
          });
        }
      }

      const txs: ParsedTransaction[] = [];
      for (const [txid, info] of txMap) {
        const isSend = info.isChange;
        let amount: bigint;
        if (isSend) {
          // sent amount = total inputs consumed by this tx - change returned
          const inputTotal = spentByMap.get(txid) ?? 0n;
          if (inputTotal > 0n) {
            // sent = inputs - change (fee is included in the difference)
            amount = inputTotal - info.changeValue;
          } else {
            // fallback: no spent_by_txid data yet (pre-rescan), show change value
            amount = info.changeValue;
          }
        } else {
          amount = info.receiveValue;
        }
        txs.push({
          id: txid,
          height: info.height || info.position,
          timestamp: null,
          type: isSend ? 'send' : 'receive',
          description: isSend ? 'Sent' : 'Received',
          amount: zatoshiToZec(amount),
          asset: 'ZEC',
        });
      }

      // merge transparent history:
      // - txids in both shielded + transparent = shielding tx → relabel as "Shielded"
      // - txids only in transparent = transparent receive → add as "Received"
      const seenTxids = new Map(txs.map((tx, i) => [tx.id, i]));
      for (const tTx of tHistory) {
        const existingIdx = seenTxids.get(tTx.txid);
        if (existingIdx !== undefined) {
          // this tx appears in both shielded notes and transparent history → shielding tx
          const existing = txs[existingIdx]!;
          existing.type = 'shield';
          existing.description = 'Shielded';
          continue;
        }
        const receivedZat = BigInt(tTx.received);
        if (receivedZat > 0n) {
          txs.push({
            id: tTx.txid,
            height: tTx.height,
            timestamp: null,
            type: 'receive',
            description: 'Received',
            amount: zatoshiToZec(receivedZat),
            asset: 'ZEC',
          });
        }
      }

      // sort by height/position descending (newest first)
      txs.sort((a, b) => b.height - a.height);
      setTransactions(txs);
      return txs;
    },
  });

  const isLoading = activeNetwork === 'penumbra' ? penumbraQuery.isLoading : zcashQuery.isLoading;
  const error = activeNetwork === 'penumbra' ? penumbraQuery.error : zcashQuery.error;
  const refetch = activeNetwork === 'penumbra' ? penumbraQuery.refetch : zcashQuery.refetch;

  useEffect(() => {
    void refetch();
  }, [activeNetwork, walletId, refetch]);

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
