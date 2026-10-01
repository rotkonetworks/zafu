import { useEffect, useRef, useState } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { Button } from '@repo/ui/components/ui/button';
import { ZCASH_ORCHARD_ACTIVATION } from '../../config/networks';
import { blockToDate, dateToBlock, formatDateInput } from '../../utils/zcash-blocks';
import { isSidePanel, isDedicatedWindow } from '../../utils/popup-detection';

/**
 * The sync strip under the header (board HomeSync): 32px of progress
 * while the wallet is not caught up, or a 44px notice in its place - offline,
 * a node that isn't answering, a witness rebuild (boards StOffline, ErrNode,
 * StWitness). Tapping it opens a sheet with the heights, the raw error and
 * the rescan-from-a-date control.
 */
export interface SyncNotice {
  tone: 'warn' | 'gold';
  text: string;
  /** a quiet second part, after the text */
  meta?: string;
  /** the raw error, behind "technical details" */
  detail?: string;
  action?: { label: string; onClick: () => void };
}

export interface SyncStatusProps {
  /** 0..100 overall progress */
  percent: number;
  /** chain tip unknown yet */
  connecting: boolean;
  currentHeight: number;
  targetHeight: number;
  startBlock: number;
  notice?: SyncNotice;
  /** a chain that can be read again from a date (zcash); absent hides it */
  onRescan?: (height: number) => void;
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
  notice,
  onRescan,
}: SyncStatusProps) => {
  const [open, setOpen] = useState(false);
  const eta = useEta(currentHeight, targetHeight, !connecting && !notice);
  const pct = Math.floor(percent);
  const warn = notice?.tone === 'warn';

  return (
    <>
      <div
        className={cn(
          'relative flex shrink-0 items-center gap-2 border-b text-xs',
          notice ? 'h-11 pl-4 pr-2' : 'h-8 px-4',
          warn ? 'border-warn/40 bg-warn/10' : 'border-border-soft bg-elev-1',
        )}
      >
        <button
          type='button'
          onClick={() => setOpen(true)}
          className='flex h-full min-w-0 flex-1 items-center gap-2 text-left'
        >
          {warn ? (
            <span className='size-2 shrink-0 bg-warn' />
          ) : (
            <span className='i-zafu-enso size-3.5 shrink-0 text-network-accent' />
          )}
          <span className={notice ? 'line-clamp-2 leading-snug text-fg' : 'truncate text-fg'}>
            {notice?.text ?? (connecting ? 'connecting' : 'syncing')}
          </span>
          {(notice ? notice.meta : !connecting) && (
            <span className='truncate text-fg-muted tabular'>
              {notice ? notice.meta : `${pct}%${eta && ` · ${eta}`}`}
            </span>
          )}
        </button>
        {notice?.action && (
          <button
            type='button'
            onClick={notice.action.onClick}
            className='flex h-7 shrink-0 items-center border border-surface-border px-2.5 text-[11px] text-zigner-gold hover:bg-elev-2'
          >
            {notice.action.label}
          </button>
        )}
        {!notice && !connecting && (
          <span
            className='absolute bottom-[-1px] left-0 h-0.5 bg-network-accent transition-[width] duration-500'
            style={{ width: `${Math.max(pct, 2)}%` }}
          />
        )}
      </div>

      <Sheet open={open} onOpenChange={setOpen} title='sync'>
        <SyncDetail
          error={warn ? notice.text : undefined}
          errorDetail={notice?.detail}
          currentHeight={currentHeight}
          targetHeight={targetHeight}
          startBlock={startBlock}
          onRescan={
            onRescan &&
            (h => {
              setOpen(false);
              onRescan(h);
            })
          }
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
}: Pick<SyncStatusProps, 'currentHeight' | 'targetHeight' | 'startBlock'> & {
  error?: string;
  errorDetail?: string;
  onRescan?: (h: number) => void;
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
        {onRescan && (
          <label className='flex h-12 items-center justify-between gap-3 px-3.5'>
            <span className='text-fg-muted'>starts from</span>
            <RescanDateInput value={date} onChange={setDate} />
          </label>
        )}
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

      {onRescan && (
        <>
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
        </>
      )}
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
