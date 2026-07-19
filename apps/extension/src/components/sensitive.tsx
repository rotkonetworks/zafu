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
 * user has "hide balances" enabled, the content is blurred and made
 * non-selectable - a display-only privacy control for shoulder-surfing and
 * screen sharing. The value stays in the DOM (no layout shift); only its
 * rendering is obscured, and it un-blurs the instant the toggle is turned off.
 *
 * Blur is applied via inline style so it does not depend on Tailwind's
 * `filter` utilities being enabled in the shared config.
 */
export const Sensitive = ({ children, className }: SensitiveProps) => {
  const hidden = useStore(selectHideBalances);
  return (
    <span
      aria-hidden={hidden || undefined}
      className={cn('inline-block', hidden && 'pointer-events-none select-none', className)}
      style={{
        filter: hidden ? 'blur(7px)' : undefined,
        transition: 'filter 150ms ease',
      }}
    >
      {children}
    </span>
  );
};
