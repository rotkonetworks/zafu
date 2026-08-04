/**
 * Per-pool Zcash notes view (NU6.3 dual-pool).
 *
 * Lists the active wallet's decrypted notes grouped by shielded pool:
 * Ironwood (active) and Orchard (legacy, migrate-only after NU6.3). A pool
 * toggle filters between them; each section shows a subtotal + count header
 * and one row per note (value, block height, spent/unspent, change flag).
 *
 * Reachable only when IRONWOOD_MIGRATION is ON (see config/feature-flags.ts);
 * the router gates the route and the menu-drawer gates the entry. Before
 * activation this is still safe to open - it is read-only and never builds a
 * transaction.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sensitive } from '../../components/sensitive';
import { useStore } from '../../state';
import { selectEffectiveKeyInfo } from '../../state/keyring';
import { getNotesInWorker, type DecryptedNoteWithTxid } from '../../state/keyring/network-worker';
import { useZcashSyncStatus } from '../../hooks/zcash-sync';
import { SettingsScreen } from './settings/settings-screen';
import { PopupPath } from './paths';
import { cn } from '@repo/ui/lib/utils';

/** Shielded pool a note lives in. Records persisted pre-ironwood default to orchard. */
type NotePool = 'orchard' | 'ironwood';

/** Pool of a note; absent `pool` (pre-ironwood records) means orchard. */
const poolOf = (note: DecryptedNoteWithTxid): NotePool => note.pool ?? 'orchard';

/**
 * Per-pool note lists, matching the contract Agent C mirrors for balances
 * (PoolBalances) in components/zcash/pool-balance-card.tsx.
 *
 * TODO(agent-b): once the data-model slice lands, replace `usePoolNotes`
 * below with Agent B's shared per-pool note selector/hook, e.g.
 *   import { selectPoolNotes, type PoolNotes } from '../../state/keyring';
 * Do NOT invent a parallel note path - the fallback here reads the SAME
 * worker source (getNotesInWorker) the rest of the wallet uses and simply
 * partitions by pool, so swapping in the selector is a drop-in.
 */
export interface PoolNotes {
  /** legacy Orchard pool notes (migrate-only after NU6.3 activation). */
  orchard: DecryptedNoteWithTxid[];
  /** active Ironwood pool notes. */
  ironwood: DecryptedNoteWithTxid[];
}

/**
 * Format zatoshi -> ZEC string. Mirrors the home / pool-balance-card
 * formatter: trim trailing zeros but keep at least four decimals so note
 * amounts read consistently ("0.0001" not "0").
 */
const fmtZec = (zat: bigint): string => {
  const whole = zat / 100_000_000n;
  const frac = zat % 100_000_000n;
  const fracStr = frac.toString().padStart(8, '0');
  const trimmed = fracStr.replace(/0+$/, '');
  const padded = trimmed.length < 4 ? fracStr.slice(0, 4) : trimmed;
  return `${whole}.${padded}`;
};

/** subtotal of note values in zatoshi. */
const subtotal = (notes: DecryptedNoteWithTxid[]): bigint =>
  notes.reduce((sum, n) => sum + BigInt(n.value), 0n);

/** true when the note has been spent (worker sets `spent` and/or spent_by_txid). */
const isSpent = (note: DecryptedNoteWithTxid): boolean =>
  note.spent === true || (!!note.spent_by_txid && note.spent_by_txid.length > 0);

/**
 * Fallback per-pool notes hook. Fetches the wallet's full note set from the
 * worker (the established path used by note-sync / history) and partitions it
 * by pool. Replace with Agent B's selector when it merges - see PoolNotes.
 */
function usePoolNotes(walletId: string | undefined): {
  notes: PoolNotes;
  loading: boolean;
  error: string | null;
  refetch: () => void;
} {
  const [notes, setNotes] = useState<PoolNotes>({ orchard: [], ironwood: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // re-fetch as sync advances so newly-scanned notes appear live
  const { workerSyncHeight } = useZcashSyncStatus();

  const load = useCallback(() => {
    if (!walletId) {
      setNotes({ orchard: [], ironwood: [] });
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    getNotesInWorker('zcash', walletId)
      .then(all => {
        const orchard: DecryptedNoteWithTxid[] = [];
        const ironwood: DecryptedNoteWithTxid[] = [];
        for (const note of all) {
          (poolOf(note) === 'ironwood' ? ironwood : orchard).push(note);
        }
        // newest first - most-recently-scanned notes at the top
        orchard.sort((a, b) => b.height - a.height);
        ironwood.sort((a, b) => b.height - a.height);
        setNotes({ orchard, ironwood });
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [walletId]);

  useEffect(() => {
    load();
  }, [load, workerSyncHeight]);

  return { notes, loading, error, refetch: load };
}

/** single note row: value, height, spent/unspent, change flag. */
function NoteRow({ note }: { note: DecryptedNoteWithTxid }) {
  const spent = isSpent(note);
  const change = note.is_change === true;

  return (
    <div className='flex items-center gap-3 rounded-lg border border-border-soft bg-elev-1 p-3'>
      <div
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
          spent ? 'bg-elev-2' : 'bg-green-500/10',
        )}
      >
        <span
          className={cn(
            'h-4 w-4',
            spent ? 'i-lucide-minus text-fg-muted' : 'i-lucide-coins text-green-400',
          )}
        />
      </div>

      <div className='min-w-0 flex-1'>
        <div className='flex items-center justify-between gap-2'>
          <span className='font-mono text-sm tabular-nums text-fg-high'>
            <Sensitive>{fmtZec(BigInt(note.value))} ZEC</Sensitive>
          </span>
          <span
            className={cn(
              'shrink-0 rounded-md px-1.5 py-0.5 text-label leading-none',
              spent ? 'bg-elev-2 text-fg-dim' : 'bg-green-500/10 text-green-400',
            )}
          >
            {spent ? 'spent' : 'unspent'}
          </span>
        </div>
        <div className='mt-0.5 flex items-center gap-2'>
          <span className='text-xs text-fg-muted'>
            {note.height > 0 ? `block ${note.height.toLocaleString()}` : 'unconfirmed'}
          </span>
          {change && (
            <span className='rounded-md bg-elev-2 px-1.5 py-0.5 text-label leading-none text-fg-dim'>
              change
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** subtotal + count header for a pool section. */
function PoolHeader({ label, notes }: { label: string; notes: DecryptedNoteWithTxid[] }) {
  const count = notes.length;
  return (
    <div className='flex items-baseline justify-between gap-2 px-0.5'>
      <span className='text-data text-fg-high lowercase'>
        {label} - {count} note{count === 1 ? '' : 's'}
      </span>
      <span className='font-mono text-xs tabular-nums text-fg-muted'>
        <Sensitive>{fmtZec(subtotal(notes))} ZEC</Sensitive>
      </span>
    </div>
  );
}

type PoolFilter = 'ironwood' | 'orchard';

export const PoolNotesPage = () => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const walletId = selectedKeyInfo?.id;
  const { notes, loading, error, refetch } = usePoolNotes(walletId);
  // ironwood is the active pool - default the toggle to it
  const [filter, setFilter] = useState<PoolFilter>('ironwood');

  const active = filter === 'ironwood' ? notes.ironwood : notes.orchard;
  const label = filter === 'ironwood' ? 'ironwood' : 'orchard';

  const emptyCopy = useMemo(() => {
    if (filter === 'ironwood') {
      return 'no ironwood notes yet';
    }
    // orchard empty reads as a win, not an error: nothing left to migrate
    return 'no orchard notes - fully migrated';
  }, [filter]);

  return (
    <SettingsScreen title='pool notes' backPath={PopupPath.INDEX}>
      <div className='flex min-h-0 flex-1 flex-col gap-3'>
        {/* pool toggle - ironwood (active) first, orchard (legacy) second */}
        <div className='flex items-center gap-1 rounded-lg bg-elev-1 p-1'>
          {(['ironwood', 'orchard'] as const).map(p => (
            <button
              key={p}
              type='button'
              onClick={() => setFilter(p)}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-data lowercase transition-colors',
                filter === p
                  ? 'bg-elev-2 text-fg-high'
                  : 'text-fg-muted hover:text-fg-high hover:bg-elev-2/50',
              )}
            >
              <span
                className={cn(
                  'h-3.5 w-3.5',
                  p === 'ironwood' ? 'i-lucide-shield-check' : 'i-lucide-clock',
                )}
              />
              <span>{p}</span>
              {p === 'orchard' && (
                <span className='rounded-md bg-elev-1 px-1 text-label leading-none text-fg-dim'>
                  legacy
                </span>
              )}
            </button>
          ))}
        </div>

        <div className='flex items-center justify-between gap-2'>
          <PoolHeader label={label} notes={active} />
          <button
            type='button'
            onClick={refetch}
            disabled={loading}
            className='shrink-0 rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-elev-1 hover:text-fg-high disabled:opacity-50'
            title='refresh'
          >
            <span className={cn('i-lucide-refresh-cw h-4 w-4', loading && 'animate-spin')} />
          </button>
        </div>

        <div className='flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto'>
          {loading && active.length === 0 ? (
            // skeleton of note-row geometry - same rhythm as real rows, no spinner
            <div className='flex flex-col gap-2 animate-pulse'>
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className='flex items-center gap-3 rounded-lg bg-elev-1 p-3'>
                  <div className='h-9 w-9 shrink-0 rounded-full bg-elev-2/60' />
                  <div className='flex-1 space-y-1.5'>
                    <div className='h-3 w-1/2 rounded-sm bg-elev-2/60' />
                    <div className='h-2 w-1/3 rounded-sm bg-elev-2/40' />
                  </div>
                </div>
              ))}
            </div>
          ) : error ? (
            <div className='flex flex-col items-center justify-center gap-3 py-12 text-center'>
              <p className='text-sm text-red-400'>failed to load notes</p>
              <button
                type='button'
                onClick={refetch}
                className='text-xs text-zigner-gold hover:underline'
              >
                try again
              </button>
            </div>
          ) : active.length === 0 ? (
            <div className='flex flex-col items-center justify-center gap-3 py-12 text-center'>
              <div className='rounded-full bg-primary/10 p-4'>
                <span
                  className={cn(
                    'h-8 w-8 text-zigner-gold',
                    filter === 'ironwood' ? 'i-lucide-shield-check' : 'i-lucide-check',
                  )}
                />
              </div>
              <p className='text-sm text-fg-muted lowercase'>{emptyCopy}</p>
            </div>
          ) : (
            active.map(note => (
              <NoteRow key={`${note.txid}:${note.position}:${note.nullifier}`} note={note} />
            ))
          )}
        </div>
      </div>
    </SettingsScreen>
  );
};

export default PoolNotesPage;
