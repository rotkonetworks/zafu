import { useEffect, useRef, useState } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { ZCASH_ORCHARD_ACTIVATION } from '../../config/networks';
import { isSidePanel, isDedicatedWindow } from '../../utils/popup-detection';

/**
 * SyncStatus — the one sync surface for the zcash home screen.
 *
 * Design intent: sync state is a *property of the balance*, not a sibling
 * feature. So it renders as a single quiet line attached to the balance —
 * an ensō that draws itself closed as the wallet becomes whole, one
 * humanized figure, and everything else (bar, stages, heights, rescan,
 * reassurance) behind one tap. Replaces the old trio of status line +
 * info card + progress card that repeated the same percent twice.
 */

export interface SyncStage {
  key: string;
  label: string;
  state: 'done' | 'active' | 'pending';
  /** short suffix shown on the active stage, e.g. "33%" or "12 blocks" */
  detail?: string;
}

export interface SyncStatusProps {
  /** 0..100 overall progress */
  percent: number;
  synced: boolean;
  /** chain tip unknown yet (connecting) */
  connecting: boolean;
  currentHeight: number;
  targetHeight: number;
  startBlock: number;
  stages: SyncStage[];
  /** true during a wallet's first scan — adds the resume-on-reopen line */
  firstSync: boolean;
  /**
   * The human message — a classified `SyncFailure.message`, never a raw
   * worker or wasm error. See `state/sync-failure.ts`.
   */
  error?: string;
  /**
   * The raw error text. Diagnostics only: kept out of the message and shown
   * behind the "technical details" disclosure, because a height, a hash, or
   * a type name is not something a person holding money can act on.
   */
  errorDetail?: string;
  errorAction?: { label: string; onClick: () => void };
  /** resume the sync from where it stopped — for transient backend errors */
  onRetry?: () => void;
  onRescan?: (height: number) => void;
}

/**
 * The ensō arc. While syncing the circle stays open like a brush stroke
 * (caps at 92/100) — it only closes completely when the wallet is synced.
 */
const EnsoArc = ({ percent, synced, dim }: { percent: number; synced: boolean; dim?: boolean }) => {
  const fill = synced ? 100 : Math.min(Math.max(percent, 4) * 0.92, 92);
  return (
    <svg width='16' height='16' viewBox='0 0 16 16' className='-rotate-90 shrink-0'>
      <circle
        cx='8'
        cy='8'
        r='6.4'
        pathLength='100'
        fill='none'
        strokeWidth='1.8'
        strokeLinecap='round'
        strokeDasharray='100'
        strokeDashoffset={100 - fill}
        className={cn(
          'transition-[stroke-dashoffset] duration-700 ease-out',
          dim ? 'stroke-fg-dim' : 'stroke-zigner-gold',
        )}
      />
    </svg>
  );
};

/** humanize a remaining-time estimate; empty string when not worth showing */
const fmtEta = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '';
  }
  if (seconds < 90) {
    return '~1 min';
  }
  if (seconds < 3600) {
    return `~${Math.round(seconds / 60)} min`;
  }
  return `~${Math.round(seconds / 3600)} h`;
};

export const SyncStatus = ({
  percent,
  synced,
  connecting,
  currentHeight,
  targetHeight,
  startBlock,
  stages,
  firstSync,
  error,
  errorDetail,
  errorAction,
  onRetry,
  onRescan,
}: SyncStatusProps) => {
  const [open, setOpen] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');

  // scan-rate window for the ETA: ring of (height, t) samples over ~45s.
  // Shown only once the rate is stable — a wrong ETA is worse than none.
  const samples = useRef<{ h: number; t: number }[]>([]);
  const [eta, setEta] = useState('');
  useEffect(() => {
    if (synced || connecting || currentHeight <= 0) {
      samples.current = [];
      setEta('');
      return;
    }
    const now = Date.now();
    const s = samples.current;
    if (s.length === 0 || currentHeight > s[s.length - 1]!.h) {
      s.push({ h: currentHeight, t: now });
    }
    while (s.length > 0 && now - s[0]!.t > 45_000) {
      s.shift();
    }
    const first = s[0];
    const last = s[s.length - 1];
    if (first && last && last.t - first.t > 8_000 && last.h > first.h) {
      const rate = ((last.h - first.h) / (last.t - first.t)) * 1000; // blocks/s
      setEta(fmtEta((targetHeight - currentHeight) / rate));
    }
  }, [currentHeight, targetHeight, synced, connecting]);

  const submitRescan = () => {
    const h = parseInt(input, 10);
    if (!isNaN(h) && h >= ZCASH_ORCHARD_ACTIVATION && onRescan) {
      onRescan(h);
    }
    setEditing(false);
    setInput('');
  };

  const line = error
    ? 'sync error'
    : connecting
      ? 'connecting…'
      : synced
        ? `synced · block ${currentHeight.toLocaleString()}`
        : `syncing ${Math.floor(percent)}%${eta ? ` · ${eta}` : ''}`;

  return (
    <div>
      {/* the one line — everything else is behind this tap */}
      <button
        type='button'
        onClick={() => setOpen(v => !v)}
        className='group/sync mt-1.5 flex items-center gap-2 text-label tabular transition-colors'
        title={open ? 'hide sync detail' : 'sync detail'}
      >
        <EnsoArc percent={percent} synced={synced} dim={connecting || !!error} />
        <span
          className={cn(
            error ? 'text-red-400' : 'text-fg-dim group-hover/sync:text-fg-muted',
            'lowercase',
          )}
        >
          {line}
        </span>
        {/* Most sync errors are transient (a node restart, a 503 blip), so the
            first offer is "try again" — resuming from the current height —
            rather than "switch node", which permanently repoints the wallet
            because of a ten-second outage. Switching lives in the panel. */}
        {error && onRetry && (
          <span
            role='button'
            tabIndex={0}
            onClick={e => {
              e.stopPropagation();
              onRetry();
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.stopPropagation();
                onRetry();
              }
            }}
            className='text-zigner-gold underline-offset-2 hover:underline lowercase'
          >
            try again
          </span>
        )}
        <span
          className={cn(
            'i-lucide-chevron-down h-3 w-3 text-fg-dim transition-transform duration-200',
            open && 'rotate-180',
          )}
        />
      </button>

      {/* the panel — grid-rows trick for a measured slide */}
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-200',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className='overflow-hidden'>
          <div className='mt-2 flex flex-col gap-2 rounded-md border border-border-soft bg-elev-1 p-3'>
            {error && (
              <div className='flex flex-col gap-1'>
                <div className='flex flex-wrap items-baseline gap-x-2 gap-y-1'>
                  <span className='text-xs text-red-400 break-words'>{error}</span>
                  {errorAction && (
                    <button
                      type='button'
                      onClick={errorAction.onClick}
                      className='text-label text-zigner-gold underline-offset-2 hover:underline lowercase'
                    >
                      {errorAction.label}
                    </button>
                  )}
                </div>
                {/* The raw error still exists — it is just not the thing we
                    say to someone holding money. One tap away, for a bug
                    report or a support chat. */}
                {errorDetail && errorDetail !== error && (
                  <div>
                    <button
                      type='button'
                      onClick={() => setShowDetail(v => !v)}
                      className='text-label text-fg-dim underline-offset-2 hover:text-fg-muted hover:underline lowercase'
                    >
                      {showDetail ? 'hide technical details' : 'technical details'}
                    </button>
                    {showDetail && (
                      <p className='mt-1 font-mono text-label text-fg-dim break-all whitespace-pre-wrap'>
                        {errorDetail}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {!synced && (
              <div className='h-1.5 w-full overflow-hidden rounded-full bg-elev-2'>
                <div
                  className='h-full rounded-full bg-zigner-gold transition-all duration-500 ease-out'
                  style={{ width: `${Math.max(percent, 2)}%` }}
                />
              </div>
            )}

            {/* pipeline stages — steady row instead of a flickering label */}
            <div className='flex flex-wrap items-center gap-x-2 gap-y-0.5 text-label lowercase'>
              {stages.map((st, i) => (
                <span key={st.key} className='flex items-center gap-2'>
                  {i > 0 && <span className='text-fg-dim'>·</span>}
                  <span
                    className={cn(
                      st.state === 'done' && 'text-fg-muted',
                      st.state === 'active' && 'text-zigner-gold',
                      st.state === 'pending' && 'text-fg-dim',
                    )}
                  >
                    {st.label}
                    {st.state === 'done' && ' ✓'}
                    {/* Show the detail on pending stages too, not just active
                        ones. A stage that is waiting is exactly the one the
                        user needs explained — dropping its detail left stages
                        like ligerito rendering as a bare word with no state
                        and no progress, indistinguishable from a hang. */}
                    {st.state !== 'done' && st.detail ? ` ${st.detail}` : ''}
                  </span>
                </span>
              ))}
            </div>

            {/* heights + rescan */}
            <div className='flex items-center justify-between text-label text-fg-muted font-mono tabular-nums'>
              <span>
                {currentHeight > 0 && targetHeight > 0
                  ? `${currentHeight.toLocaleString()} / ${targetHeight.toLocaleString()}`
                  : '—'}
              </span>
              {onRescan &&
                (editing ? (
                  <span className='flex items-center gap-1'>
                    <input
                      type='number'
                      min={ZCASH_ORCHARD_ACTIVATION}
                      value={input}
                      onChange={e => setInput(e.target.value)}
                      placeholder={String(startBlock)}
                      className='w-20 bg-elev-2 px-1.5 py-0.5 text-label font-mono text-fg placeholder:text-fg-muted outline-none'
                      autoFocus
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          submitRescan();
                        } else if (e.key === 'Escape') {
                          setEditing(false);
                          setInput('');
                        }
                      }}
                    />
                    <button
                      onClick={submitRescan}
                      className='text-label text-zigner-gold hover:underline'
                    >
                      rescan
                    </button>
                    <button
                      onClick={() => {
                        setEditing(false);
                        setInput('');
                      }}
                      className='text-label text-fg-muted hover:text-fg-high'
                    >
                      &times;
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => {
                      setEditing(true);
                      setInput(String(startBlock));
                    }}
                    className='hover:text-fg-high transition-colors'
                    title='rescan from a different block height'
                  >
                    from {startBlock > 0 ? startBlock.toLocaleString() : '0'}
                  </button>
                ))}
            </div>

            {firstSync && !synced && !error && <SyncPersistenceNote />}
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Where the scan actually lives, stated honestly per context.
 *
 * Scanning runs in a Worker owned by whichever view spawned it. The toolbar
 * POPUP is destroyed on focus loss, taking the worker with it; the side panel
 * and a dedicated window are not. So the popup gets an actionable nudge rather
 * than a flat "this stops" — the side panel already gives background sync
 * today, without waiting on moving the worker into the offscreen document.
 */
const SyncPersistenceNote = () => {
  const persists = isSidePanel() || isDedicatedWindow();
  if (persists) {
    return (
      <div className='text-label text-fg-dim leading-snug'>
        scanning continues while this stays open.
      </div>
    );
  }
  return (
    <div className='text-label text-fg-dim leading-snug'>
      the popup closes when it loses focus, which pauses the scan (it resumes where it left off).
      open zafu in the side panel to let it run in the background.
    </div>
  );
};
