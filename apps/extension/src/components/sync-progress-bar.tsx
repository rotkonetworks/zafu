import { cn } from '@repo/ui/lib/utils';

interface SyncProgressBarProps {
  percent: number;
  label: string;
  done?: boolean;
  error?: string;
  barColor: string;
  barDoneColor?: string;
}

export const SyncProgressBar = ({
  percent,
  label,
  done,
  error,
  barColor,
  barDoneColor,
}: SyncProgressBarProps) => {
  if (done) return null;

  return (
    <div className='rounded-lg border border-border/40 bg-card p-3'>
      {error && (
        <div className='text-xs text-red-400 mb-2'>{error}</div>
      )}

      <div className='h-2 w-full overflow-hidden rounded-sm bg-muted'>
        <div
          className={cn('h-full transition-all duration-500 ease-out', done ? barDoneColor : barColor)}
          style={{ width: `${Math.max(percent, 2)}%` }}
        />
      </div>

      <div className='mt-1.5 text-xs text-muted-foreground tabular-nums'>
        {label}
      </div>
    </div>
  );
};
