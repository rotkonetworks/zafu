import { useEffect, useRef, useState } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { Button } from '@repo/ui/components/ui/button';
import { ZCASH_ORCHARD_ACTIVATION } from '../../config/networks';
import { blockToDate, dateToBlock, formatDateInput } from '../../utils/zcash-blocks';
import { isSidePanel, isDedicatedWindow } from '../../utils/popup-detection';

/**
 * The zcash sync strip: one 32px line under the header while the wallet is
 * not caught up (board HomeSync). Tapping it opens a sheet with the heights,
 * the classified error and the rescan-from-a-date control.
 */
export interface SyncStatusProps {
  /** 0..100 overall progress */
  percent: number;
  /** chain tip unknown yet */
  connecting: boolean;
  currentHeight: number;
  targetHeight: number;
  startBlock: number;
  /** a classified `SyncFailure.message`, never a raw worker error */
  error?: string;
  /** the raw error, behind "technical details" */
  errorDetail?: string;
  errorAction?: { label: string; onClick: () => void };
  onRetry: () => void;
  onRescan: (height: number) => void;
}

/** humanize a remaining-time estimate; empty when not worth showing */
const fmtEta = (seconds: number): string =>
  !Number.isFinite(seconds) || seconds <= 0
    ? ''
    : seconds < 90
      ? 'about 1 min'
      : seconds < 3600
        ? `about ${Math.round(seconds / 60)} min`
        : `about ${Math.round(seconds / 3600)} h`;

/** scan-rate ETA over a ~45s window; shown only once the rate is stable */
const useEta = (current: number, target: number, active: boolean) => {
  const samples = useRef<{ h: number; t: number }[]>([]);
  const [eta, setEta] = useState('');
  useEffect(() => {
    if (!active || current <= 0) {
      samples.current = [];
      setEta('');
      return;
    }
    const now = Date.now();
    const s = samples.current;
    if (s.length === 0 || current > s[s.length - 1]!.h) {
      s.push({ h: current, t: now });
    }
    while (s.length > 0 && now - s[0]!.t > 45_000) {
      s.shift();
    }
    const first = s[0];
    const last = s[s.length - 1];
    if (first && last && last.t - first.t > 8_000 && last.h > first.h) {
      setEta(fmtEta((target - current) / (((last.h - first.h) / (last.t - first.t)) * 1000)));
    }
  }, [current, target, active]);
  return eta;
};

export const SyncStatus = ({
  percent,
  connecting,
  currentHeight,
  targetHeight,
  startBlock,
  error,
  errorDetail,
  errorAction,
  onRetry,
  onRescan,
}: SyncStatusProps) => {
  const [open, setOpen] = useState(false);
  const eta = useEta(currentHeight, targetHeight, !connecting && !error);
  const pct = Math.floor(percent);

  return (
    <>
      <div className='relative flex h-8 shrink-0 items-center gap-2 border-b border-border-soft bg-elev-1 px-4 text-xs'>
        <button
          type='button'
          onClick={() => setOpen(true)}
          className='flex min-w-0 flex-1 items-center gap-2 text-left'
        >
          <span
            className={cn(
              'size-3.5 shrink-0',
              error ? 'i-ph-warning text-hanko' : 'i-zafu-enso text-zigner-gold',
            )}
          />
          {error ? (
            <span className='truncate text-fg'>{error}</span>
          ) : connecting ? (
            <span className='text-fg'>connecting</span>
          ) : (
            <>
              <span className='text-fg'>syncing</span>
              <span className='truncate text-fg-muted tabular'>
                {pct}%{eta && ` · ${eta}`}
              </span>
            </>
          )}
        </button>
        {error && (
          <button
            type='button'
            onClick={errorAction?.onClick ?? onRetry}
            className='shrink-0 text-zigner-gold hover:underline'
          >
            {errorAction?.label ?? 'try again'}
          </button>
        )}
        {!error && !connecting && (
          <span
            className='absolute bottom-[-1px] left-0 h-0.5 bg-zigner-gold transition-[width] duration-500'
            style={{ width: `${Math.max(pct, 2)}%` }}
          />
        )}
      </div>

      <Sheet open={open} onOpenChange={setOpen} title='sync'>
        <SyncDetail
          error={error}
          errorDetail={errorDetail}
          currentHeight={currentHeight}
          targetHeight={targetHeight}
          startBlock={startBlock}
          onRescan={h => {
            setOpen(false);
            onRescan(h);
          }}
        />
      </Sheet>
    </>
  );
};

const SyncDetail = ({
  error,
  errorDetail,
  currentHeight,
  targetHeight,
  startBlock,
  onRescan,
}: Pick<
  SyncStatusProps,
  'error' | 'errorDetail' | 'currentHeight' | 'targetHeight' | 'startBlock'
> & {
  onRescan: (h: number) => void;
}) => {
  const [date, setDate] = useState(() => dateOfBlock(startBlock));
  const [showDetail, setShowDetail] = useState(false);
  const rescanAt = rescanHeightOf(date);
  const persists = isSidePanel() || isDedicatedWindow();

  return (
    <div className='flex flex-col gap-3 text-xs'>
      <div className='flex flex-col divide-y divide-border-soft border border-border-soft'>
        <div className='flex h-12 items-center justify-between px-3.5'>
          <span className='text-fg-muted'>block</span>
          <span className='text-fg-high tabular'>
            {currentHeight > 0 ? currentHeight.toLocaleString() : '-'}
            {targetHeight > 0 && ` of ${targetHeight.toLocaleString()}`}
          </span>
        </div>
        <label className='flex h-12 items-center justify-between gap-3 px-3.5'>
          <span className='text-fg-muted'>starts from</span>
          <RescanDateInput value={date} onChange={setDate} />
        </label>
      </div>

      {error && (
        <div className='flex flex-col gap-1'>
          <span className='text-hanko'>{error}</span>
          {errorDetail && errorDetail !== error && (
            <button
              type='button'
              onClick={() => setShowDetail(v => !v)}
              className='self-start text-fg-dim hover:text-fg-muted'
            >
              {showDetail ? 'hide technical details' : 'technical details'}
            </button>
          )}
          {showDetail && (
            <p className='max-h-24 overflow-y-auto font-mono text-label text-fg-dim break-all'>
              {errorDetail}
            </p>
          )}
        </div>
      )}

      <Button
        variant='secondary'
        disabled={!rescanHeightOk(rescanAt)}
        onClick={() => onRescan(rescanAt)}
      >
        sync again from {isNaN(rescanAt) ? 'a date' : `block ${rescanAt.toLocaleString()}`}
      </Button>

      <span className='text-label text-fg-dim'>
        {persists
          ? 'scanning continues while this stays open'
          : 'the scan pauses when the popup closes and resumes where it left off'}
      </span>
    </div>
  );
};

/** the date a scan from `block` starts on, as an <input type=date> value; '' when unknown */
export const dateOfBlock = (block: number) =>
  block > 0 ? formatDateInput(blockToDate(block)) : '';

/** the block a rescan from an <input type=date> value starts at; NaN when empty */
export const rescanHeightOf = (date: string) =>
  date ? dateToBlock(new Date(`${date}T00:00:00Z`)) : NaN;

export const rescanHeightOk = (h: number) => !isNaN(h) && h >= ZCASH_ORCHARD_ACTIVATION;

/** a date picker bounded by orchard activation and today */
export const RescanDateInput = ({
  value,
  onChange,
}: {
  value: string;
  onChange: (date: string) => void;
}) => (
  <input
    type='date'
    min={formatDateInput(blockToDate(ZCASH_ORCHARD_ACTIVATION))}
    max={formatDateInput(new Date())}
    value={value}
    onChange={e => onChange(e.target.value)}
    aria-label='starts from'
    className='bg-transparent text-right text-fg-high outline-none'
  />
);
