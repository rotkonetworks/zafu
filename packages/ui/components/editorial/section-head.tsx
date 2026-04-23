import { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * Section header — a three-column row used above every content block:
 *
 *   [ 01 | section label | ───────────── ]
 *     hint goes here on row 2 (optional)
 *
 * Matches the preview in `packages/ui/docs/design-preview/colors.html`:
 * `grid-template-columns: 12ch 1fr auto` with n / label / rule in the first
 * row and an optional hint on row 2. Rule spans the remaining width after
 * the label via `1fr auto`.
 *
 *   <SectionHead n="03" label="ink · text shades" hint="hierarchy by weight, not size" />
 */
export interface SectionHeadProps {
  /** Left-column numbering — usually two-digit "01", "02", etc. */
  n?: ReactNode;
  /** Main section label — lowercase by convention. */
  label: ReactNode;
  /** Right-column hint / sub-description. Optional. */
  hint?: ReactNode;
  className?: string;
}

export const SectionHead = ({ n, label, hint, className }: SectionHeadProps) => (
  <div
    className={cn(
      'grid grid-cols-[12ch_auto_1fr] items-center gap-[18px] mb-[18px]',
      className,
    )}
  >
    <div className='text-[10px] text-fg-dim tabular tracking-[0.1em]'>{n}</div>
    <div className='section-label'>{label}</div>
    <div className='rule' />
    {hint && (
      <div className='col-span-3 text-[10px] text-fg-dim lowercase'>{hint}</div>
    )}
  </div>
);
