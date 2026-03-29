/**
 * multisig sessions — bottom tab for FROST threshold wallets
 *
 * shows all multisig wallets (active + historical) with:
 * - balance, threshold, last activity
 * - filter: has funds, recent activity
 * - sort: by balance, by time
 * - quick actions: create, join, sign
 *
 * inspired by Safe wallet's transaction queue UX.
 */

import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../../state';
import { PopupPath } from '../paths';
import { localExtStorage } from '@repo/storage-chrome/local';

/** historical multisig event (persisted in localStorage) */
export interface MultisigEvent {
  /** unique event id */
  id: string;
  /** wallet address (links to multisig wallet) */
  address: string;
  /** event type */
  type: 'dkg-complete' | 'sign-complete' | 'sign-rejected';
  /** unix ms timestamp */
  timestamp: number;
  /** human label */
  label?: string;
  /** amount in zatoshis (for sign events) */
  amount?: number;
  /** counterparty address */
  counterparty?: string;
  /** room code used */
  roomCode?: string;
}

type SortKey = 'time' | 'balance';
type FilterKey = 'all' | 'funded' | 'recent';

/** read multisig wallets from zustand store */
const useMultisigWallets = () => {
  return useStore(s =>
    (s.wallets.zcashWallets ?? []).filter(w => w.multisig)
  );
};

export const MultisigSessions = () => {
  const navigate = useNavigate();
  const wallets = useMultisigWallets();
  const [sort, setSort] = useState<SortKey>('time');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [events] = useState<MultisigEvent[]>([]); // TODO: load from localStorage

  const sorted = useMemo(() => {
    let list = [...wallets];

    // filter
    if (filter === 'funded') {
      // TODO: filter by balance > 0 when balance tracking is available
      list = list.filter(() => true);
    } else if (filter === 'recent') {
      // show wallets with activity in last 7 days
      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      list = list.filter(w => {
        const lastEvent = events.find(e => e.address === w.address);
        return lastEvent ? lastEvent.timestamp > weekAgo : false;
      });
    }

    // sort
    if (sort === 'balance') {
      // TODO: sort by actual balance when available
      list.sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''));
    } else {
      // sort by creation time (most recent first)
      list.sort((a, b) => {
        const aEvent = events.find(e => e.address === a.address && e.type === 'dkg-complete');
        const bEvent = events.find(e => e.address === b.address && e.type === 'dkg-complete');
        return (bEvent?.timestamp ?? 0) - (aEvent?.timestamp ?? 0);
      });
    }

    return list;
  }, [wallets, sort, filter, events]);

  return (
    <div className='flex flex-col min-h-full'>
      {/* header */}
      <div className='flex items-center justify-between px-4 pt-4 pb-2'>
        <h2 className='text-sm font-medium'>multisig</h2>
        <div className='flex gap-1'>
          <button
            onClick={() => navigate(PopupPath.MULTISIG_CREATE)}
            className='flex items-center gap-1 rounded-md bg-primary/10 px-2.5 py-1 text-[10px] font-medium text-primary hover:bg-primary/20 transition-colors'
          >
            <span className='i-lucide-plus h-3 w-3' />
            create
          </button>
          <button
            onClick={() => navigate(PopupPath.MULTISIG_JOIN)}
            className='flex items-center gap-1 rounded-md bg-muted px-2.5 py-1 text-[10px] font-medium text-muted-foreground hover:bg-muted/80 transition-colors'
          >
            <span className='i-lucide-log-in h-3 w-3' />
            join
          </button>
        </div>
      </div>

      {/* filter + sort bar */}
      <div className='flex items-center gap-2 px-4 pb-3'>
        <div className='flex rounded-md bg-muted/50 p-0.5 text-[9px]'>
          {(['all', 'funded', 'recent'] as FilterKey[]).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2 py-0.5 rounded transition-colors ${
                filter === f
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <div className='flex-1' />
        <button
          onClick={() => setSort(sort === 'time' ? 'balance' : 'time')}
          className='flex items-center gap-1 text-[9px] text-muted-foreground hover:text-foreground transition-colors'
        >
          <span className={sort === 'time' ? 'i-lucide-clock h-3 w-3' : 'i-lucide-coins h-3 w-3'} />
          {sort}
        </button>
      </div>

      {/* wallet list */}
      <div className='flex-1 px-4 pb-4'>
        {sorted.length === 0 ? (
          <div className='flex flex-col items-center justify-center py-12 gap-3'>
            <span className='i-lucide-shield h-10 w-10 text-muted-foreground/20' />
            <p className='text-xs text-muted-foreground/60 text-center'>
              {wallets.length === 0
                ? 'no multisig wallets yet'
                : 'no wallets match filter'}
            </p>
            {wallets.length === 0 && (
              <p className='text-[10px] text-muted-foreground/40 text-center max-w-xs'>
                create a threshold wallet with other signers, or join an existing group
              </p>
            )}
          </div>
        ) : (
          <div className='flex flex-col gap-2'>
            {sorted.map(wallet => {
              const ms = wallet.multisig!;
              const recentEvents = events
                .filter(e => e.address === wallet.address)
                .sort((a, b) => b.timestamp - a.timestamp)
                .slice(0, 3);

              return (
                <div
                  key={wallet.id}
                  className='rounded-lg border border-border/40 bg-card overflow-hidden'
                >
                  {/* wallet header */}
                  <div className='p-3'>
                    <div className='flex items-center justify-between'>
                      <div className='flex items-center gap-2 min-w-0'>
                        <span className='i-lucide-shield h-4 w-4 text-muted-foreground flex-shrink-0' />
                        <span className='text-xs font-medium truncate'>
                          {wallet.label || 'multisig'}
                        </span>
                        <span className='text-[9px] text-muted-foreground/60 bg-muted/50 px-1 py-0.5 rounded flex-shrink-0'>
                          {ms.threshold}-of-{ms.maxSigners}
                        </span>
                      </div>
                      <button
                        onClick={() => navigate(PopupPath.MULTISIG_SIGN)}
                        className='flex items-center gap-1 text-[9px] text-primary hover:text-primary/80 transition-colors flex-shrink-0'
                      >
                        <span className='i-lucide-pen-tool h-3 w-3' />
                        sign
                      </button>
                    </div>

                    {/* address */}
                    <div className='mt-1 font-mono text-[9px] text-muted-foreground/50 truncate'>
                      {wallet.address}
                    </div>
                  </div>

                  {/* recent activity */}
                  {recentEvents.length > 0 && (
                    <div className='border-t border-border/20 px-3 py-2'>
                      {recentEvents.map(event => (
                        <div key={event.id} className='flex items-center gap-2 py-0.5'>
                          <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${
                            event.type === 'sign-complete' ? 'bg-green-400' :
                            event.type === 'sign-rejected' ? 'bg-red-400' :
                            'bg-blue-400'
                          }`} />
                          <span className='text-[9px] text-muted-foreground/60 truncate'>
                            {event.type === 'dkg-complete' ? 'created' :
                             event.type === 'sign-complete' ? `signed${event.amount ? ` ${(event.amount / 1e8).toFixed(4)} ZEC` : ''}` :
                             'rejected'}
                          </span>
                          <span className='text-[9px] text-muted-foreground/30 ml-auto flex-shrink-0'>
                            {formatRelativeTime(event.timestamp)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return new Date(timestamp).toLocaleDateString();
}

/** save a multisig event to localStorage */
export async function logMultisigEvent(event: Omit<MultisigEvent, 'id'>): Promise<void> {
  const history = (await localExtStorage.get('multisigHistory') as MultisigEvent[] | undefined) ?? [];
  history.push({
    ...event,
    id: `${event.address.slice(0, 8)}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  });
  // keep last 500 events
  if (history.length > 500) history.splice(0, history.length - 500);
  await localExtStorage.set('multisigHistory', history);
}
