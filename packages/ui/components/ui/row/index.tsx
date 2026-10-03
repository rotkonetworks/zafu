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
  /** an image in the icon's place, e.g. a bundled token logo */
  media?: React.ReactNode;
  label: string;
  description?: string;
  disabled?: boolean;
  className?: string;
  /** opens a Sheet explaining this setting, via a small "?" after the label.
   *  called with the row's own label, so the sheet can title itself without
   *  the caller repeating the label a second time. */
  onExplain?: (label: string) => void;
  /** where a press goes (a route path), so the app can preload it on intent */
  preload?: string;
}

export type RowProps = RowBaseProps &
  (
    | { type: 'screen'; onPress: () => void }
    | { type: 'value'; value?: string; tone?: 'warn' | 'danger'; onPress: () => void }
    | { type: 'toggle'; checked: boolean; onChange: (next: boolean) => void }
  );

export function Row(props: RowProps) {
  const { icon, media, label, description, disabled, className, onExplain, preload } = props;

  const rowClass = cn(
    'flex min-h-[50px] w-full items-center gap-3 px-3.5 py-2 text-left transition-colors',
    props.type !== 'toggle' && 'hover:bg-surface-elev-2',
    disabled && 'pointer-events-none opacity-50',
    className,
  );

  const content = (
    <>
      {media ??
        (icon && <span className={cn(icon, 'size-5 shrink-0 text-fg-muted')} aria-hidden='true' />)}
      <span className='flex min-w-0 flex-1 flex-col gap-0.5'>
        <span className='flex items-center gap-2'>
          <span className='truncate text-sm text-fg-high lowercase'>{label}</span>
          {onExplain && (
            <button
              type='button'
              onClick={e => {
                e.stopPropagation();
                onExplain(label);
              }}
              aria-label={`explain ${label}`}
              className='inline-flex size-4 shrink-0 items-center justify-center border border-surface-border text-[10px] text-fg-dim'
            >
              ?
            </button>
          )}
        </span>
        {description && (
          <span className='truncate text-[11px] text-fg-muted lowercase'>{description}</span>
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

  // the "?" is its own button, so a value/screen row with onExplain can't
  // also be a <button> (no nested interactive elements) - a div with
  // button semantics carries the row's own press instead.
  if (onExplain) {
    return (
      <div
        role='button'
        tabIndex={disabled ? undefined : 0}
        onClick={props.onPress}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            props.onPress();
          }
        }}
        aria-disabled={disabled}
        data-preload={preload}
        className={rowClass}
      >
        {content}
      </div>
    );
  }

  return (
    <button
      type='button'
      onClick={props.onPress}
      disabled={disabled}
      data-preload={preload}
      className={rowClass}
    >
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
