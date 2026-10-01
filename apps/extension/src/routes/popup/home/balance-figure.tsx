import { cn } from '@repo/ui/lib/utils';
import { Sensitive } from '../../../components/sensitive';
import { fmtZecHero } from './format';

/**
 * The hero balance figure, in the four states it can honestly be in.
 *
 * The previous version rendered ` - ZEC` whenever the wallet had not yet
 * reported a sync height, which covered "still loading", "failed to read" and
 * "genuinely zero" with one blank dash. A dash where a number belongs does not
 * read as "unknown", it reads as "gone" - which is exactly what a user who had
 * just sent a real payment concluded. Each state now says which it is.
 *
 * `partial` still shows the number: a figure that is a floor is far more use
 * than no figure, so long as it is not passed off as a total.
 */
export const BalanceFigure = ({
  view,
  zec,
}: {
  view: 'loading' | 'error' | 'unknown' | 'partial' | 'ready';
  zec: number;
}) => {
  if (view === 'loading') {
    return (
      <div className='flex items-baseline gap-2 text-hero leading-none'>
        {/* sized to the figure it replaces, so nothing shifts when it arrives */}
        <span className='inline-block h-[0.7em] w-40 animate-pulse rounded bg-elev-2' />
        <span className='text-label text-fg-dim lowercase'>reading balance</span>
      </div>
    );
  }

  // Scanning, nothing found yet. The wallet has not read the blocks that hold
  // its own notes - including the change from its own recent sends - so it does
  // not know the balance. Show a loading skeleton rather than a misleading 0 or
  // dash; the sync line just below carries the actual progress, so words here
  // would only repeat it.
  if (view === 'unknown') {
    return (
      <div className='flex items-center' aria-label='balance syncing'>
        <span className='inline-block h-[0.9em] w-32 animate-pulse rounded-md bg-elev-2' />
      </div>
    );
  }

  if (view === 'error') {
    return (
      <div className='flex items-baseline gap-2 text-hero leading-none'>
        <span className='text-fg-dim tabular'> - </span>
        {/* the dash is only ever allowed next to the word that explains it */}
        <span className='text-label text-hanko lowercase'>balance unavailable</span>
      </div>
    );
  }

  return (
    // number + unit on one line, no wrap: the number ellipsizes if it is ever
    // long enough to overflow the card (full precision is one click away in the
    // pool view), and the unit stays pinned so it never disappears.
    <div className='flex min-w-0 items-baseline gap-1.5'>
      {/* while still scanning, the balance pulses instead of a "so far" chip -
          a live, non-final value; the sync bar carries the actual progress. */}
      <span
        className={cn(
          'min-w-0 truncate text-hero leading-none tracking-tight text-network-accent tabular',
          view === 'partial' && 'animate-pulse',
        )}
        title={view === 'partial' ? 'still scanning - more funds may yet be found' : undefined}
      >
        <Sensitive>{fmtZecHero(zec)}</Sensitive>
      </span>
      {/* The ticker used to be set at text-display in the accent, the same as
          the amount - so "ZEC" carried equal visual weight to the number and
          the figure read flat. A unit is a subordinate mark: it identifies the
          number, it is not the thing you came to read. Dropped a step in the
          scale and to 60% accent, which restores the hierarchy without
          reaching for another colour. */}
      <span className='shrink-0 text-title leading-none text-network-accent/60 tabular'>ZEC</span>
    </div>
  );
};
