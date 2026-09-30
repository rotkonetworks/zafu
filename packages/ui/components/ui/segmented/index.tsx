import { cn } from '../../../lib/utils';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** shown after the label when set, e.g. a count */
  meta?: string | number;
  /** icon className, e.g. i-ph-shield-check */
  icon?: string;
  disabled?: boolean;
}

/**
 * Segmented - a pill-shaped tab strip for choosing between a small, fixed
 * set of options (2 or more). role="radiogroup" / role="radio", square
 * corners, 1px border. Replaces hand-written tab-state rows (pool-notes,
 * inbox, contacts, send, multisig sessions, identity, zcash-vote, contact
 * dialogs, the appearance picker) and the two-option pickers that used to
 * be bespoke (privacy/transparent-chain, asset/positions, word length).
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (next: T) => void;
  options: readonly SegmentedOption<T>[];
  /** accessible name for the group */
  label?: string;
  className?: string;
}) {
  return (
    <div
      role='radiogroup'
      aria-label={label}
      className={cn('flex border border-surface-border-soft bg-surface-elev-1', className)}
    >
      {options.map(o => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type='button'
            role='radio'
            aria-checked={selected}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs lowercase transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              selected ? 'bg-surface-border-soft text-fg-high' : 'text-fg-muted hover:text-fg-high',
            )}
          >
            {o.icon && <span className={cn(o.icon, 'size-3.5')} />}
            {o.label}
            {o.meta != null && o.meta !== '' ? ` (${o.meta})` : ''}
          </button>
        );
      })}
    </div>
  );
}
