import type { ReactNode } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { useStore } from '../state';
import { selectHideBalances } from '../state/privacy';

interface SensitiveProps {
  children: ReactNode;
  className?: string;
}

/**
 * Wraps a sensitive on-screen value (typically a balance amount). When the
 * user has "hide balances" enabled, the value is replaced with a
 * constant-width mask.
 *
 * Deliberately NOT a blur: blurring preserves glyph count and decimal
 * position, so "0.0100" and "12,438.0000" blur to visibly different
 * shapes — a shoulder-surfer still learns the magnitude. The mask is the
 * same five dots for every value, and the real value is removed from the
 * DOM entirely while hidden (so devtools/copy can't recover it either).
 */
export const Sensitive = ({ children, className }: SensitiveProps) => {
  const hidden = useStore(selectHideBalances);
  if (hidden) {
    return (
      <span
        aria-label='hidden'
        className={cn('inline-block select-none tracking-widest', className)}
      >
        •••••
      </span>
    );
  }
  return <span className={cn('inline-block', className)}>{children}</span>;
};
