/**
 * The send flow's screens, shared by every network (boards Send, Proving,
 * SendError). A network varies only by data: the unit, the stage table and
 * the copy it passes in; the accent follows the popup's data-network.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { Button } from '@repo/ui/components/ui/button';
import { CopyButton } from '@repo/ui/components/ui/copy-button';
import { RowGroup } from '@repo/ui/components/ui/row';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { Mark as StampMark } from '@repo/ui/components/ui/mark';
import { ScreenHeader } from '../../../components/screen-header';
import { Sensitive } from '../../../components/sensitive';
import { sendStage, stageMeta, type SendProgress, type Stages } from './send-stage';

/** board address form: head and tail that identify it, u1v9ga…qrdva */
export const shortAddress = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-5)}` : a);

export const isTransparentAddress = (a: string) => /^(t1|t3|tm|t2)/.test(a.trim());

export const Main = ({ children, className }: { children: ReactNode; className?: string }) => (
  <main className={cn('flex min-h-0 grow flex-col overflow-y-auto px-4', className)}>
    {children}
  </main>
);

export const Footer = ({ children, className }: { children: ReactNode; className?: string }) => (
  <footer
    className={cn('flex shrink-0 gap-2 border-t border-border-soft px-4 pb-4 pt-3', className)}
  >
    {children}
  </footer>
);

/** the fixed one-line helper under a field; blank keeps its height */
export const Helper = ({ warn, children }: { warn?: boolean; children?: ReactNode }) => (
  <span className={cn('h-4 truncate text-[11px]', warn ? 'text-warn' : 'text-fg-muted')}>
    {children}
  </span>
);

/** what is being signed, pinned under the header */
export const Strip = ({
  icon,
  children,
  right,
}: {
  icon?: string;
  children: ReactNode;
  right?: ReactNode;
}) => (
  <div className='flex h-11 shrink-0 items-center gap-2 border-b border-border-soft bg-elev-1 px-4'>
    {icon && <span className={cn(icon, 'size-3.5 shrink-0 text-fg-muted')} />}
    <span className='truncate text-xs text-fg'>{children}</span>
    {right && <span className='ml-auto shrink-0 text-[11px] text-fg-muted'>{right}</span>}
  </div>
);

/** a square marker: filled when done, ringed while active, faint while waiting */
export const Mark = ({ state }: { state: 'done' | 'now' | 'wait' }) => (
  <span
    className={cn(
      'size-3.5 shrink-0',
      state === 'done' && 'bg-network-accent',
      state === 'now' && 'animate-pulse border-2 border-network-accent',
      state === 'wait' && 'border border-border-hard',
    )}
  />
);

/** "1.25 zec": the display figure with its unit in the network's accent */
export const Figure = ({
  amount,
  unit,
  className,
}: {
  amount: ReactNode;
  unit: string;
  className?: string;
}) => (
  <Sensitive>
    <span className={cn('font-display text-[40px] leading-tight text-fg-high', className)}>
      {amount} <span className='text-lg text-network-accent'>{unit}</span>
    </span>
  </Sensitive>
);

export type Fact = readonly [label: string, value: ReactNode];

/** label left, value right, 48px rows in one box */
export const Facts = ({ rows }: { rows: readonly Fact[] }) => (
  <RowGroup>
    {rows.map(([k, v]) => (
      <div key={k} className='flex h-12 items-center justify-between gap-3 px-3.5'>
        <span className='shrink-0 text-xs text-fg-muted'>{k}</span>
        <span className='truncate text-[13px] text-fg-high'>{v}</span>
      </div>
    ))}
  </RowGroup>
);

/** the one line saying who can see this */
export const PrivacyLine = ({ children }: { children: ReactNode }) => (
  <div className='flex h-10 items-center gap-2 border border-border-soft px-3'>
    <span className='i-lucide-shield size-3.5 shrink-0 text-network-accent' />
    <span className='truncate text-xs text-fg'>{children}</span>
  </div>
);

/** board Send, review: what leaves, to whom, at what cost, and who can see it */
export const Review = ({
  title = 'review',
  meta = '2 / 2',
  lead = 'you send',
  amount,
  unit,
  rows,
  privacy,
  confirm,
  onEdit,
  onConfirm,
  children,
}: {
  title?: string;
  meta?: ReactNode;
  lead?: string;
  amount: ReactNode;
  unit: string;
  rows: readonly Fact[];
  privacy?: ReactNode;
  confirm: string;
  onEdit: () => void;
  onConfirm: () => void;
  /** anything the network adds under the privacy line */
  children?: ReactNode;
}) => (
  <>
    <ScreenHeader title={title} onBack={onEdit} meta={meta} />
    <Main className='gap-[22px] pt-6'>
      <div className='flex flex-col items-center gap-1.5 pb-1 pt-2'>
        <span className='text-xs text-fg-muted'>{lead}</span>
        <Figure amount={amount} unit={unit} />
      </div>
      <Facts rows={rows} />
      {privacy && <PrivacyLine>{privacy}</PrivacyLine>}
      {children}
    </Main>
    <Footer>
      <Button variant='secondary' onClick={onEdit} className='w-[110px]'>
        edit
      </Button>
      <Button onClick={onConfirm} className='grow'>
        {confirm}
      </Button>
    </Footer>
  </>
);

const ENSO = 'M14.9 4.1 A8.8 8.8 0 1 0 19.4 8.3';

export const Sealed = ({ children }: { children: ReactNode }) => (
  <Main className='relative items-center justify-center gap-3.5 overflow-hidden px-6'>
    <svg
      aria-hidden
      width='360'
      height='360'
      viewBox='0 0 24 24'
      fill='none'
      strokeWidth='0.6'
      strokeLinecap='round'
      className='pointer-events-none absolute stroke-network-accent opacity-[0.08]'
    >
      <path d={ENSO} />
    </svg>
    <StampMark variant='stamp' glyph='済' size={84} className='mb-0.5' />
    <span className='font-display text-[26px] text-fg-high'>sent</span>
    {children}
  </Main>
);

/** board Send, sent: the 済 stamp, one line, the hash, and the way on */
export const Done = ({
  line,
  txHash,
  note,
  onDone,
  children,
}: {
  line: ReactNode;
  txHash?: string;
  /** under the hash, e.g. where an ibc transfer has got to */
  note?: ReactNode;
  onDone: () => void;
  /** secondary footer actions, before "done" */
  children?: ReactNode;
}) => (
  <>
    <ScreenHeader title='done' onBack={onDone} />
    <Sealed>
      <span className='text-[13px] text-fg-muted'>{line}</span>
      {txHash && (
        <span className='flex items-center gap-1.5 text-xs text-fg-muted'>
          {shortAddress(txHash)}
          <CopyButton text={txHash} />
        </span>
      )}
      {note}
    </Sealed>
    <Footer>
      {children}
      <Button onClick={onDone} className='grow'>
        done
      </Button>
    </Footer>
  </>
);

/** board SendError: what stopped, owned calmly, and the way back */
export const Stopped = ({
  title = 'send stopped',
  sending,
  error,
  onCancel,
  onRetry,
}: {
  title?: string;
  sending: ReactNode;
  error?: string | null;
  onCancel: () => void;
  onRetry: () => void;
}) => (
  <>
    <ScreenHeader title={title} onBack={onRetry} />
    <Strip>{sending}</Strip>
    <Main className='pt-5'>
      <StatusSlot tone='warn' icon='i-ph-warning'>
        {error || 'something broke on our side, not yours'}
      </StatusSlot>
    </Main>
    <Footer>
      <Button variant='secondary' onClick={onCancel} className='w-[110px]'>
        cancel
      </Button>
      <Button onClick={onRetry} className='grow'>
        try again
      </Button>
    </Footer>
  </>
);

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <>{Math.max(0, Math.floor((now - since) / 1000))}s</>;
}

/** the ensō, the network's stages, and one sentence on what is happening now */
export function Proving({
  stages,
  steps,
  floor,
  since,
  hot,
}: {
  stages: Stages;
  steps: readonly SendProgress[];
  floor: number;
  since: number;
  hot: boolean;
}) {
  const active = sendStage(stages, steps, floor);
  return (
    <Main className='gap-[18px] pt-[22px]'>
      <div className='relative grid h-[132px] shrink-0 place-items-center'>
        <svg
          aria-hidden
          width='120'
          height='120'
          viewBox='0 0 24 24'
          fill='none'
          strokeWidth='1.2'
          strokeLinecap='round'
          className='animate-[spin_2.8s_linear_infinite] stroke-network-accent'
        >
          <path d={ENSO} />
        </svg>
        <span className='absolute font-display text-[28px] text-fg-high'>
          <Elapsed since={since} />
        </span>
      </div>
      <ol className='flex flex-col divide-y divide-border-soft border border-border-soft bg-elev-1'>
        {stages.names.map((name, i) => (
          <li key={name} className='flex h-11 items-center gap-3 px-3.5'>
            <Mark state={i < active ? 'done' : i === active ? 'now' : 'wait'} />
            <span className={cn('grow text-[13px]', i > active ? 'text-fg-muted' : 'text-fg-high')}>
              {name}
            </span>
            <span className='text-[11px] text-fg-muted'>{stageMeta(stages, steps, i, active)}</span>
          </li>
        ))}
      </ol>
      <p className='border border-gold-line bg-zigner-gold/10 px-3.5 py-3 text-xs leading-normal text-fg-high'>
        {stages.explain(steps, active, hot)}
      </p>
    </Main>
  );
}

/** what the reserved line under a running build says */
export type SendingNote = 'leave' | 'slow' | 'stopping' | 'on-its-way';

const NOTE: Record<SendingNote, (stoppable: boolean) => string> = {
  leave: () => 'you can close this · it keeps going and shows on home',
  slow: stoppable =>
    stoppable
      ? 'this is taking longer than usual · keep waiting or stop it'
      : 'this is taking longer than usual · thank you for waiting',
  stopping: () => 'stopping this send',
  'on-its-way': () => 'it is already on its way',
};

/**
 * The footer of every running build: one reserved line, a quiet way to stop
 * while nothing has left yet, and the way back to the wallet.
 */
export const SendingFooter = ({
  note = 'leave',
  onStop,
  onClose,
}: {
  note?: SendingNote;
  /** offered only before anything is broadcast */
  onStop?: () => void;
  /** the way back to the wallet; a sheet has its own */
  onClose?: () => void;
}) => (
  <Footer className='flex-col'>
    <span
      className={cn(
        'flex h-[18px] items-center justify-center text-[11px]',
        note === 'slow' ? 'text-zigner-gold' : 'text-fg-muted',
      )}
    >
      {NOTE[note](!!onStop)}
    </span>
    <div className='flex gap-2'>
      {onStop && (
        <Button
          variant='quiet'
          onClick={onStop}
          disabled={note === 'stopping'}
          className={cn('h-11 text-[13px]', onClose ? 'w-[132px]' : 'grow')}
        >
          stop this send
        </Button>
      )}
      {onClose && (
        <Button variant='secondary' onClick={onClose} className='h-11 grow'>
          back to wallet
        </Button>
      )}
    </div>
  </Footer>
);

/** board Proving: the sending screen, which may be left while it runs */
export const Sending = ({
  meta,
  onClose,
  onStop,
  note,
  ...proving
}: Parameters<typeof Proving>[0] & {
  meta: ReactNode;
  onClose: () => void;
  onStop?: () => void;
  note?: SendingNote;
}) => (
  <>
    <ScreenHeader title='sending' backPath={false} meta={meta} />
    <Proving {...proving} />
    <SendingFooter note={note} onStop={onStop} onClose={onClose} />
  </>
);
