import { useState } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { ZCASH_ORCHARD_ACTIVATION } from '../config/networks';

interface SyncProgressBarProps {
  percent: number;
  label: string;
  done?: boolean;
  error?: string;
  barColor: string;
  barDoneColor?: string;
  /** current synced block height */
  currentHeight?: number;
  /** target chain tip height */
  targetHeight?: number;
  /** wallet birthday / start block — shown as clickable if onRescan is provided */
  startBlock?: number;
  /** called when user submits a new start block for rescan */
  onRescan?: (height: number) => void;
  /**
   * Optional recovery affordance shown next to the error message.
   * When set, the error row gets a clickable action — e.g. on Zcash
   * pointing at the network picker so a new user whose default node
   * is unreachable can switch to a different LWD without first
   * figuring out the settings tree.
   */
  errorAction?: { label: string; onClick: () => void };
}

export const SyncProgressBar = ({
  percent,
  label,
  done,
  error,
  barColor,
  barDoneColor,
  currentHeight,
  targetHeight,
  startBlock,
  onRescan,
  errorAction,
}: SyncProgressBarProps) => {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');

  if (done) return null;

  const submitRescan = () => {
    const h = parseInt(input, 10);
    if (!isNaN(h) && h >= ZCASH_ORCHARD_ACTIVATION && onRescan) {
      onRescan(h);
    }
    setEditing(false);
    setInput('');
  };

  const showHeights = currentHeight != null && targetHeight != null
    && targetHeight > 0 && currentHeight < targetHeight;

  return (
    <div className='rounded-lg border border-border-soft bg-elev-1 p-3'>
      {error && (
        <div className='mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-red-400'>
          <span className='break-words'>{error}</span>
          {errorAction && (
            <button
              type='button'
              onClick={errorAction.onClick}
              className='text-zigner-gold underline-offset-2 hover:underline lowercase tracking-[0.02em]'
            >
              {errorAction.label}
            </button>
          )}
        </div>
      )}

      <div className='h-2 w-full overflow-hidden rounded-full bg-elev-2'>
        <div
          className={cn('h-full rounded-full transition-all duration-500 ease-out', done ? barDoneColor : barColor)}
          style={{ width: `${Math.max(percent, 2)}%` }}
        />
      </div>

      {/* row 1: label */}
      <div className='mt-1.5 text-xs text-fg-muted'>{label}</div>

      {/* row 2: heights + rescan — only when there's something to show */}
      {(showHeights || (startBlock != null && onRescan)) && (
        <div className='mt-0.5 flex items-center justify-between text-[10px] text-fg-muted font-mono tabular-nums'>
          {showHeights ? (
            <span>{currentHeight.toLocaleString()} / {targetHeight.toLocaleString()}</span>
          ) : <span />}

          {startBlock != null && onRescan && (
            editing ? (
              <span className='flex items-center gap-1'>
                <input
                  type='number'
                  min={ZCASH_ORCHARD_ACTIVATION}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  placeholder={String(startBlock)}
                  className='w-20 bg-elev-2 px-1.5 py-0.5 text-[10px] font-mono text-fg placeholder:text-fg-muted outline-none'
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === 'Enter') submitRescan();
                    else if (e.key === 'Escape') { setEditing(false); setInput(''); }
                  }}
                />
                <button onClick={submitRescan} className='text-[10px] text-zigner-gold hover:underline'>rescan</button>
                <button onClick={() => { setEditing(false); setInput(''); }} className='text-[10px] text-fg-muted hover:text-fg-high'>&times;</button>
              </span>
            ) : (
              <button
                onClick={() => { setEditing(true); setInput(String(startBlock)); }}
                className='hover:text-fg-high transition-colors'
                title='rescan from different block height'
              >
                from {startBlock > 0 ? startBlock.toLocaleString() : '0'}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
};
