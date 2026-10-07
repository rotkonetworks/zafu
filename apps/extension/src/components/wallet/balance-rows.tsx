import { Clipped } from '@repo/ui/components/ui/clipped';
import type { ReactNode } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { Sensitive } from '../sensitive';

/** a titled group of balance rows, one hairline between them */
export const BalanceGroup = ({
  heading,
  held,
  children,
}: {
  heading: string;
  /** still another pocket's rows: dimmed until this one's land */
  held?: boolean;
  children: ReactNode;
}) => (
  <section className='flex flex-col gap-2' aria-busy={held}>
    <h2 className='text-xs tracking-[0.04em] text-fg-muted'>{heading}</h2>
    <div
      className={cn(
        'flex flex-col divide-y divide-border-soft border border-border-soft',
        held && 'opacity-40',
      )}
    >
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

/** a balance row: tile, name over a quiet tag, amount over its note, optional action */
export const BalanceRow = ({
  tile,
  label,
  tag,
  amount,
  note,
  onPress,
  action,
}: {
  tile: ReactNode;
  label: string;
  tag: ReactNode;
  amount?: string;
  note?: ReactNode;
  onPress?: () => void;
  action?: ReactNode;
}) => (
  <div className='flex h-[58px] items-center gap-3 bg-elev-1 px-3 transition-colors hover:bg-elev-2'>
    <button
      type='button'
      onClick={onPress}
      disabled={!onPress}
      className='flex min-w-0 flex-1 items-center gap-3 text-left'
    >
      {tile}
      <span className='flex min-w-0 flex-1 flex-col gap-[3px]'>
        <Clipped className='text-sm text-fg-high lowercase'>{label}</Clipped>
        {typeof tag === 'string' ? (
          <Clipped className='text-[11px] text-fg-muted'>{tag}</Clipped>
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
);

/** one small action on a balance line: an icon, named for screen readers */
export interface LineAction {
  icon: string;
  label: string;
  onPress: () => void;
  busy?: boolean;
}

/** a row's actions as small icons, side by side */
export const LineActions = ({ actions }: { actions: LineAction[] }) => (
  <span className='flex shrink-0 items-center'>
    {actions.map(a => (
      <button
        key={a.label}
        type='button'
        onClick={a.onPress}
        disabled={a.busy}
        aria-label={a.label}
        title={a.label}
        className='grid size-7 place-items-center text-fg-muted transition-colors hover:text-fg-high disabled:text-fg-dim'
      >
        <span className={cn(a.icon, 'size-3.5', a.busy && 'animate-spin')} aria-hidden='true' />
      </button>
    ))}
  </span>
);

/**
 * the unshielded side of one token on one chain, in its sheet: what waits on
 * a public address, and what to do about it. Nothing here asks any node; the
 * caller decides what a press does.
 */
export const UnshieldedLine = ({
  children,
  found,
  actions,
}: {
  children: ReactNode;
  /** something is waiting: the line reads as a figure, not a hint */
  found?: boolean;
  actions: LineAction[];
}) => (
  <div className='flex min-h-8 items-center gap-2 border-t border-border-soft pr-1.5 pl-3.5 text-[11px] first:border-t-0'>
    <Clipped className={cn('flex-1', found ? 'text-fg-high' : 'text-fg-muted')}>{children}</Clipped>
    <LineActions actions={actions} />
  </div>
);
