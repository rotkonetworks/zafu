/**
 * skeleton loading primitives - perceived performance
 * shows content shape before data loads
 */

import { cn } from '@repo/ui/lib/utils';

interface SkeletonProps {
  className?: string;
}

/** basic skeleton block */
export const Skeleton = ({ className }: SkeletonProps) => (
  <div className={cn('animate-pulse bg-muted rounded', className)} />
);

/** skeleton for balance display */
export const BalanceSkeleton = () => (
  <div className='flex items-center justify-between border border-border/40 bg-card p-4'>
    <div className='space-y-2'>
      <Skeleton className='h-3 w-12' />
      <Skeleton className='h-7 w-24' />
      <Skeleton className='h-3 w-20' />
    </div>
    <div className='flex gap-2'>
      <Skeleton className='h-10 w-10' />
      <Skeleton className='h-10 w-10' />
    </div>
  </div>
);

/** skeleton for asset list */
export const AssetListSkeleton = ({ rows = 3 }: { rows?: number }) => (
  <div className='space-y-2'>
    <Skeleton className='h-4 w-12 mb-2' />
    {Array.from({ length: rows }).map((_, i) => (
      <div key={i} className='flex items-center justify-between py-2'>
        <div className='flex items-center gap-2'>
          <Skeleton className='h-8 w-8 rounded-full' />
          <div className='space-y-1'>
            <Skeleton className='h-4 w-16' />
            <Skeleton className='h-3 w-12' />
          </div>
        </div>
        <div className='text-right space-y-1'>
          <Skeleton className='h-4 w-20' />
          <Skeleton className='h-3 w-12' />
        </div>
      </div>
    ))}
  </div>
);

/** skeleton for network item */
export const NetworkItemSkeleton = () => (
  <div className='flex items-center gap-2 px-2 py-1.5'>
    <Skeleton className='h-2 w-2 rounded-full' />
    <Skeleton className='h-4 w-16' />
  </div>
);
