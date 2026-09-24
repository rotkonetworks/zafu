/**
 * What zafu is doing right now: every tracked transaction that is still in
 * flight, plus the ones that just ended (so a toast you missed is still here).
 * Mounted at the top of home; renders nothing when there is nothing to show.
 */

import { isTerminal, removeTxOps, type TxOp } from '../tx-ops';
import { useTxOps } from '../tx-ops/use-tx-ops';

/** finished ops stay on the card this long */
const SHOW_FINISHED_MS = 2 * 60_000;

const visible = (op: TxOp, now: number): boolean =>
  !isTerminal(op.status) || op.status !== 'done' || now - op.updatedAt < SHOW_FINISHED_MS;

const statusText = (op: TxOp): string => {
  switch (op.status) {
    case 'pending':
      return op.step ?? 'working';
    case 'done':
      return 'sent';
    case 'failed':
      return op.error ?? 'failed';
    case 'unknown':
      return op.error ?? 'no answer - check activity';
  }
};

export const InFlightCard = () => {
  const now = Date.now();
  const ops = useTxOps().filter(op => visible(op, now));
  if (!ops.length) {
    return null;
  }
  return (
    <div className='border border-border-soft bg-elev-1'>
      {ops.map(op => (
        <div
          key={op.opId}
          className='flex items-center gap-2 border-b border-border-soft px-3 py-2 last:border-b-0'
        >
          <span
            className={`h-4 w-4 shrink-0 ${
              op.status === 'pending'
                ? 'i-lucide-loader-circle animate-spin text-fg-muted'
                : op.status === 'done'
                  ? 'i-ph-check-circle text-zigner-gold'
                  : 'i-ph-warning text-hanko'
            }`}
          />
          <div className='min-w-0 flex-1'>
            <p className='truncate text-xs text-fg-high lowercase'>{op.label}</p>
            <p
              className={`truncate text-label lowercase ${
                op.status === 'failed' || op.status === 'unknown' ? 'text-hanko' : 'text-fg-muted'
              }`}
              title={statusText(op)}
            >
              {statusText(op)}
            </p>
          </div>
          <span className='shrink-0 text-label text-fg-dim'>{op.network}</span>
          {isTerminal(op.status) && (
            <button
              type='button'
              onClick={() => void removeTxOps([op.opId])}
              className='shrink-0 text-fg-muted hover:text-fg-high'
              aria-label='dismiss'
            >
              <span className='i-ph-x h-3.5 w-3.5' />
            </button>
          )}
        </div>
      ))}
    </div>
  );
};
