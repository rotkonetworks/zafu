/**
 * Instant, CSS-only tooltip. Native `title` has a ~1s browser delay and shows a
 * `?` help cursor; this appears immediately on hover/focus with no delay and no
 * cursor change. No JS, no portal - a positioned bubble revealed by group-hover.
 *
 * Use for the short "what is this" alt text we'd otherwise put in `title`. For
 * long-form content or content that must escape an overflow-clipped parent,
 * prefer the Radix Tooltip in @repo/ui.
 */

import type { ReactNode } from 'react';
import { cn } from '@repo/ui/lib/utils';

export const Hint = ({
  label,
  children,
  className,
  side = 'top',
}: {
  /** the tooltip text */
  label: string;
  /** the trigger (icon, badge, ...) */
  children: ReactNode;
  className?: string;
  side?: 'top' | 'bottom';
}) => (
  <span className={cn('group/hint relative inline-flex items-center', className)} tabIndex={0}>
    {children}
    <span
      role='tooltip'
      className={cn(
        'pointer-events-none absolute left-1/2 z-[200] w-max max-w-[220px] -translate-x-1/2',
        'rounded-md border border-border-soft bg-elev-2 px-2 py-1 text-label leading-snug lowercase text-fg shadow-lg',
        'opacity-0 transition-opacity duration-100',
        'group-hover/hint:opacity-100 group-focus/hint:opacity-100',
        side === 'top' ? 'bottom-full mb-1' : 'top-full mt-1',
      )}
    >
      {label}
    </span>
  </span>
);
