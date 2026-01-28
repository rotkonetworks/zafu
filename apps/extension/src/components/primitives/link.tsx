/**
 * link primitives with hover prefetch
 * starts loading on hover for instant navigation
 */

import { useCallback, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@repo/ui/lib/utils';

interface PrefetchLinkProps {
  to: string;
  prefetch?: () => Promise<unknown>;
  children: ReactNode;
  className?: string;
}

/**
 * link that prefetches on hover
 * by the time user clicks, content is already loading
 */
export const PrefetchLink = ({ to, prefetch, children, className }: PrefetchLinkProps) => {
  const navigate = useNavigate();

  const handleMouseEnter = useCallback(() => {
    // start prefetch on hover - don't await
    prefetch?.();
  }, [prefetch]);

  const handleClick = useCallback(() => {
    navigate(to);
  }, [navigate, to]);

  return (
    <button
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onFocus={handleMouseEnter}
      className={cn('cursor-pointer', className)}
    >
      {children}
    </button>
  );
};

/**
 * preload a route's lazy component
 */
export const preloadComponent = (importFn: () => Promise<unknown>) => {
  void importFn();
};
