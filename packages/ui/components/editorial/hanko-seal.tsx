import * as React from 'react';
import { cn } from '../../lib/utils';

/**
 * HankoSeal — the vermillion identity/receipt stamp.
 *
 * A hanko is a personal seal pressed in vermillion ink: it marks identity
 * (who) and finality (done). Two uses in zafu, nothing else:
 *
 *   - receipts: a tx broadcast gets stamped 封 ("sealed")
 *   - zid identity: a zid renders as its own seal — the glyph is the
 *     first character of the nick, so every identity has a personal stamp
 *
 * Real seals never land perfectly straight — the default -5° rotation is
 * the point, not a bug. Pass `straight` for tabular contexts where a
 * rotated mark would fight the grid.
 */
export interface HankoSealProps extends React.HTMLAttributes<HTMLDivElement> {
  /** character(s) inside the seal — e.g. 封 for receipts, nick initial for zids */
  glyph: string;
  /** edge length; glyph scales with it */
  size?: 'sm' | 'md' | 'lg';
  /** disable the hand-pressed rotation */
  straight?: boolean;
}

const SIZE = {
  sm: 'w-6 h-6 text-[13px] rounded-[4px] border',
  md: 'w-10 h-10 text-[19px] rounded-md border-[1.5px]',
  lg: 'w-[74px] h-[74px] text-[30px] rounded-lg border-2',
} as const;

/** inner keyline inset per size — the double-ring look of a carved seal */
const INNER = {
  sm: 'inset-[2px] rounded-[2px]',
  md: 'inset-[3px] rounded-[4px]',
  lg: 'inset-[4px] rounded-md',
} as const;

export const HankoSeal = React.forwardRef<HTMLDivElement, HankoSealProps>(
  ({ glyph, size = 'md', straight = false, className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'relative flex items-center justify-center select-none',
        'border-hanko text-hanko',
        SIZE[size],
        !straight && '-rotate-[5deg]',
        className,
      )}
      {...props}
    >
      <span aria-hidden className={cn('absolute border border-hanko/35', INNER[size])} />
      {glyph}
    </div>
  ),
);
HankoSeal.displayName = 'HankoSeal';

/** deterministic seal glyph for a zid nick — first grapheme, uppercased */
export function zidSealGlyph(nick: string): string {
  const first = [...nick.trim()][0];
  return (first ?? '?').toUpperCase();
}
