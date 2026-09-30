import * as React from 'react';
import { cn } from '../../../lib/utils';
import { Toggle } from '../toggle';

/**
 * Row - the three settings row shapes, and nothing else:
 *   - screen: navigates. chevron trailing.
 *   - value: opens a Sheet of options (the screen owns the Sheet and its
 *     open state; Row only calls onPress). shows the current value + chevron.
 *   - toggle: flips in place. a Toggle trailing, no chevron.
 *
 * Wrap a list of Rows in <RowGroup> for the bordered box with 1px dividers
 * from the canvas. min-height 52px (touch target), square corners.
 */
export interface RowBaseProps {
  icon?: string;
  label: string;
  description?: string;
  disabled?: boolean;
  className?: string;
}

export type RowProps = RowBaseProps &
  (
    | { type: 'screen'; onPress: () => void }
    | { type: 'value'; value?: string; tone?: 'warn' | 'danger'; onPress: () => void }
    | { type: 'toggle'; checked: boolean; onChange: (next: boolean) => void }
  );

export function Row(props: RowProps) {
  const { icon, label, description, disabled, className } = props;

  const rowClass = cn(
    'flex min-h-[52px] w-full items-center gap-3 px-3.5 py-2 text-left transition-colors',
    props.type !== 'toggle' && 'hover:bg-surface-elev-2',
    disabled && 'pointer-events-none opacity-50',
    className,
  );

  const content = (
    <>
      {icon && <span className={cn(icon, 'size-5 shrink-0 text-fg-muted')} aria-hidden='true' />}
      <span className='flex min-w-0 flex-1 flex-col gap-0.5'>
        <span className='truncate text-data text-fg-high lowercase'>{label}</span>
        {description && (
          <span className='truncate text-label text-fg-muted lowercase'>{description}</span>
        )}
      </span>
      {props.type === 'value' && props.value != null && (
        <span
          className={cn(
            'shrink-0 text-label',
            props.tone === 'warn' && 'text-warn',
            props.tone === 'danger' && 'text-hanko-light',
            !props.tone && 'text-fg-muted',
          )}
        >
          {props.value}
        </span>
      )}
      {(props.type === 'value' || props.type === 'screen') && (
        <span className='i-ph-caret-right size-3.5 shrink-0 text-fg-dim' aria-hidden='true' />
      )}
      {props.type === 'toggle' && (
        <Toggle
          checked={props.checked}
          onChange={props.onChange}
          label={label}
          disabled={disabled}
        />
      )}
    </>
  );

  if (props.type === 'toggle') {
    return <div className={rowClass}>{content}</div>;
  }

  return (
    <button type='button' onClick={props.onPress} disabled={disabled} className={rowClass}>
      {content}
    </button>
  );
}

export function RowGroup({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col divide-y divide-surface-border-soft border border-surface-border-soft bg-surface-elev-1',
        className,
      )}
    >
      {children}
    </div>
  );
}
