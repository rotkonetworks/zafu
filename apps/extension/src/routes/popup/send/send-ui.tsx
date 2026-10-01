import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { Mark as StampMark } from '@repo/ui/components/ui/mark';
import { SEND_STAGES, sendStage, stageExplain, stageMeta, type SendProgress } from './send-stage';

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
      state === 'done' && 'bg-zigner-gold',
      state === 'now' && 'animate-pulse border-2 border-zigner-gold',
      state === 'wait' && 'border border-border-hard',
    )}
  />
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
      className='pointer-events-none absolute stroke-zigner-gold opacity-[0.08]'
    >
      <path d={ENSO} />
    </svg>
    <StampMark variant='stamp' glyph='済' size={84} className='mb-0.5' />
    <span className='font-display text-[26px] text-fg-high'>sent</span>
    {children}
  </Main>
);

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <>{Math.max(0, Math.floor((now - since) / 1000))}s</>;
}

/** the ensō, the four stages, and one sentence on what is happening now */
export function Proving({
  steps,
  floor,
  since,
  hot,
}: {
  steps: readonly SendProgress[];
  floor: number;
  since: number;
  hot: boolean;
}) {
  const active = sendStage(steps, floor);
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
          className='animate-[spin_2.8s_linear_infinite] stroke-zigner-gold'
        >
          <path d={ENSO} />
        </svg>
        <span className='absolute font-display text-[28px] text-fg-high'>
          <Elapsed since={since} />
        </span>
      </div>
      <ol className='flex flex-col divide-y divide-border-soft border border-border-soft bg-elev-1'>
        {SEND_STAGES.map((name, i) => (
          <li key={name} className='flex h-11 items-center gap-3 px-3.5'>
            <Mark state={i < active ? 'done' : i === active ? 'now' : 'wait'} />
            <span className={cn('grow text-[13px]', i > active ? 'text-fg-muted' : 'text-fg-high')}>
              {name}
            </span>
            <span className='text-[11px] text-fg-muted'>{stageMeta(steps, i, active)}</span>
          </li>
        ))}
      </ol>
      <p className='border border-gold-line bg-zigner-gold/10 px-3.5 py-3 text-xs leading-normal text-fg-high'>
        {stageExplain(steps, active, hot)}
      </p>
    </Main>
  );
}
