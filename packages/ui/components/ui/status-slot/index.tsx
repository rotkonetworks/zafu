import * as React from 'react';
import { cn } from '../../../lib/utils';

/**
 * StatusSlot - a reserved-space notice line for status, progress or errors.
 * It never pushes layout: callers that need a fixed height reserve it around
 * the slot (this component sizes to its content, which is the common case
 * for a banner/notice; screens with a truly fixed-height reservation wrap it
 * in a container of their own fixed height and let this fill it).
 *
 * Replaces the hand-rolled notice/banner boxes (IronwoodMigrationBanner's
 * markup, DeprecationNotice, the onboarding NoticeBox) and inline error
 * boxes: one shape, four tones, an optional action and an optional progress
 * bar.
 */
interface StatusAction {
  label: string;
  onClick: () => void;
}

export interface StatusSlotProps {
  tone?: 'info' | 'warn' | 'danger' | 'gold';
  icon?: string;
  children: React.ReactNode;
  /** one action, or a few side by side (a calm choice between ways on) */
  action?: StatusAction | StatusAction[];
  /** 0-100; renders a thin bar under the content when set */
  progress?: number;
  className?: string;
}

const TONE_CLASS: Record<NonNullable<StatusSlotProps['tone']>, string> = {
  info: 'border-surface-border-soft bg-surface-elev-2/40 text-fg-muted',
  warn: 'border-warn/40 bg-warn/10 text-warn',
  danger: 'border-hanko/40 bg-hanko/10 text-hanko-light',
  gold: 'border-zigner-gold/40 bg-zigner-gold/10 text-fg-high',
};

export function StatusSlot({
  tone = 'info',
  icon,
  children,
  action,
  progress,
  className,
}: StatusSlotProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 border p-3 text-left text-xs',
        TONE_CLASS[tone],
        className,
      )}
    >
      {/* the action wraps under the text rather than squeezing it into a column */}
      <div className='flex flex-wrap items-start justify-between gap-x-2 gap-y-1.5'>
        <div className='flex items-start gap-1.5'>
          {icon && <span className={cn(icon, 'mt-0.5 size-3.5 shrink-0')} aria-hidden='true' />}
          <div className='flex flex-col gap-1 lowercase'>{children}</div>
        </div>
        {(action ? [action].flat() : []).map(a => (
          <button
            key={a.label}
            type='button'
            onClick={a.onClick}
            className='shrink-0 text-label underline-offset-2 hover:underline'
          >
            {a.label}
          </button>
        ))}
      </div>
      {progress != null && (
        <div className='h-[3px] w-full overflow-hidden bg-surface-border-soft'>
          <div
            className='h-full bg-zigner-gold transition-all duration-500 ease-out'
            style={{ width: `${Math.max(progress, 2)}%` }}
          />
        </div>
      )}
    </div>
  );
}
