/**
 * Instant tooltip. Native `title` has a ~1s browser delay + a `?` cursor; this
 * appears immediately (Radix `delayDuration={0}`) with a normal cursor.
 *
 * Backed by the Radix Tooltip in @repo/ui so the bubble is PORTALED to the body:
 * it escapes `overflow-hidden`/`overflow-y-auto` ancestors (the popup's scroll
 * containers used to clip a CSS-only tooltip) and auto-shifts/flips to stay
 * on-screen instead of overflowing the panel edge.
 *
 * Same API as before (`label`, children trigger, `side`) - callers don't change.
 */

import type { ReactNode } from 'react';
import { cn } from '@repo/ui/lib/utils';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@repo/ui/components/ui/tooltip';

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
  side?: 'top' | 'bottom' | 'left' | 'right';
}) => (
  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('inline-flex items-center', className)}>{children}</span>
      </TooltipTrigger>
      <TooltipContent
        side={side}
        collisionPadding={8}
        className='max-w-[220px] whitespace-normal lowercase'
      >
        {label}
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
);
