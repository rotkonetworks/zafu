import type { ReactNode } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { Sensitive } from '../sensitive';

/** a titled group of balance rows, one hairline between them */
export const BalanceGroup = ({ heading, children }: { heading: string; children: ReactNode }) => (
  <section className='flex flex-col gap-2'>
    <h2 className='text-xs tracking-[0.04em] text-fg-muted'>{heading}</h2>
    <div className='flex flex-col divide-y divide-border-soft border border-border-soft'>
      {children}
    </div>
  </section>
);

const TILE = {
  accent: 'bg-network-accent text-zigner-gold-foreground',
  warn: 'border border-warn text-warn',
  quiet: 'bg-elev-2 text-fg-muted',
} as const;

/** a row's square monogram */
export const Tile = ({ tone, children }: { tone: keyof typeof TILE; children: string }) => (
  <span
    className={cn(
      'grid size-[30px] shrink-0 place-items-center lowercase',
      children.length > 1 ? 'text-[13px]' : 'text-[15px]',
      TILE[tone],
    )}
  >
    {children}
  </span>
);

/**
 * a balance row: tile, name over a quiet tag, amount over its note, optional
 * action; `below` is a second line under it (the unshielded side of the asset)
 */
export const BalanceRow = ({
  tile,
  label,
  tag,
  amount,
  note,
  onPress,
  action,
  below,
}: {
  tile: ReactNode;
  label: string;
  tag: ReactNode;
  amount?: string;
  note?: ReactNode;
  onPress?: () => void;
  action?: ReactNode;
  below?: ReactNode;
}) => (
  <div className='bg-elev-1'>
    <div className='flex h-[58px] items-center gap-3 px-3 transition-colors hover:bg-elev-2'>
      <button
        type='button'
        onClick={onPress}
        disabled={!onPress}
        className='flex min-w-0 flex-1 items-center gap-3 text-left'
      >
        {tile}
        <span className='flex min-w-0 flex-1 flex-col gap-[3px]'>
          <span className='truncate text-sm text-fg-high lowercase'>{label}</span>
          {typeof tag === 'string' ? (
            <span className='truncate text-[11px] text-fg-muted'>{tag}</span>
          ) : (
            tag
          )}
        </span>
        {amount !== undefined && (
          <span className='flex shrink-0 flex-col items-end gap-[3px]'>
            <Sensitive className='text-sm text-fg-high tabular'>{amount}</Sensitive>
            {note}
          </span>
        )}
      </button>
      {action}
    </div>
    {below}
  </div>
);

/**
 * the unshielded side of one asset, under its row: what waits on a public
 * address, and the one thing to do about it. Nothing here asks any node; the
 * caller decides what a press does.
 */
export const UnshieldedLine = ({
  children,
  found,
  action,
}: {
  children: ReactNode;
  /** something is waiting: the line reads as a figure, not a hint */
  found?: boolean;
  action: { label: string; onPress: () => void; busy?: boolean };
}) => (
  <div className='flex min-h-9 items-center gap-3 border-t border-border-soft px-3 pl-[54px] text-[11px]'>
    <span className={cn('min-w-0 flex-1 truncate', found ? 'text-fg-high' : 'text-fg-muted')}>
      {children}
    </span>
    <button
      type='button'
      onClick={action.onPress}
      disabled={action.busy}
      className='shrink-0 text-network-accent transition-colors hover:text-fg-high disabled:text-fg-dim'
    >
      {action.label}
    </button>
  </div>
);
