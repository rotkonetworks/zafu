import { useEffect, useState } from 'react';
import { cn } from '../../../lib/utils';

export interface StepListItem {
  step: string;
  detail?: string;
  /** milliseconds since the operation started */
  elapsedMs: number;
}

function LiveElapsed({ startMs }: { startMs: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!startMs) {
      return;
    }
    const tick = () => setElapsed((Date.now() - startMs) / 1000);
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [startMs]);
  return <>{elapsed.toFixed(1)}s</>;
}

/**
 * StepList - a scrolling, timestamped log of the sub-steps of one
 * long-running operation (building a transaction, broadcasting, ...). The
 * most recent step reads at full contrast; earlier ones recede. Replaces the
 * byte-for-byte duplicated step-log renderer in zcash-send.tsx,
 * swap/index.tsx and subscribe.tsx (same `{ step, detail?, elapsedMs }[]`
 * shape, same timestamp + duration-since-previous formatting in all three).
 *
 * `liveSinceMs` (the wall-clock start of the whole operation, e.g.
 * `buildStartRef.current`) makes the last row's timestamp a live-ticking
 * timer with a pulsing dot instead of a static value - zcash-send's variant
 * of this log wants that; the others don't pass it and get the plain log.
 */
export function StepList({
  steps,
  liveSinceMs,
  className,
}: {
  steps: readonly StepListItem[];
  liveSinceMs?: number;
  className?: string;
}) {
  if (steps.length === 0) {
    return <span className='text-label font-mono text-fg-muted animate-pulse'>preparing...</span>;
  }
  return (
    <div className={cn('flex flex-col gap-1.5 overflow-y-auto', className)}>
      {steps.map((s, i) => {
        const isLast = i === steps.length - 1;
        const prevMs = i > 0 ? steps[i - 1]!.elapsedMs : 0;
        const dur = ((s.elapsedMs - prevMs) / 1000).toFixed(1);
        return (
          <div
            key={i}
            className={cn(
              'flex items-start gap-2 text-label font-mono',
              isLast ? 'text-fg' : 'text-fg-muted',
            )}
          >
            <span
              className={cn('w-10 shrink-0 text-right tabular-nums', isLast && liveSinceMs != null && 'text-zigner-gold')}
            >
              {isLast && liveSinceMs != null ? (
                <LiveElapsed startMs={liveSinceMs + s.elapsedMs} />
              ) : (
                `${(s.elapsedMs / 1000).toFixed(1)}s`
              )}
            </span>
            <span>
              {s.step}
              {s.detail && <span className='ml-1 text-fg-muted'>({s.detail})</span>}
              {!isLast && Number(dur) >= 0.5 && <span className='ml-1 text-fg-muted'>+{dur}s</span>}
              {isLast && liveSinceMs != null && (
                <span className='ml-1 inline-block size-1.5 animate-pulse rounded-full bg-zigner-gold align-middle' />
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
