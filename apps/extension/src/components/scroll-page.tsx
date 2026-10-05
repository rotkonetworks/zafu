/**
 * The pieces every full-tab page in the scroll frame shares (buy.html,
 * lp.html): the column's title block, the ask-once list of who the page will
 * talk to, the honest step lines of a wait, and the clock those waits show.
 */

import { useState, type ReactNode } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { cn } from '@repo/ui/lib/utils';

/** the clock the waits show (one shared hook) */
export { useNow } from '../hooks/use-now';

export const Column = ({
  title,
  sub,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
}) => (
  <div className='flex flex-col gap-5'>
    <div className='flex flex-col gap-2'>
      <h1 className='font-display text-[38px] leading-[1.15] text-fg-high'>{title}</h1>
      {sub && <p className='text-[13px] leading-relaxed text-fg-muted'>{sub}</p>}
    </div>
    {children}
  </div>
);

export interface Host {
  mark: string;
  name: string;
  does: string;
  host: string;
  /** the mark's tone */
  c: string;
}

/** the services a page talks to, asked once, together */
export const AskOnce = ({
  sub,
  hosts,
  onAllow,
  onNotNow,
}: {
  sub: string;
  hosts: Host[];
  onAllow: () => void;
  onNotNow: () => void;
}) => (
  <Column title='before we begin' sub={sub}>
    <div className='flex flex-col border border-border-soft bg-elev-1'>
      {hosts.map(h => (
        <div
          key={h.name}
          className='flex h-[68px] items-center gap-3.5 border-t border-border-soft px-[18px] first:border-t-0'
        >
          <span
            className={`grid size-[30px] shrink-0 place-items-center border border-border-hard text-[13px] ${h.c}`}
          >
            {h.mark}
          </span>
          <span className='flex flex-1 flex-col gap-1'>
            <span className='text-sm text-fg-high'>{h.name}</span>
            <span className='text-xs text-fg-muted'>{h.does}</span>
          </span>
          <span className='whitespace-pre-line text-right text-[11px] leading-normal text-fg-dim'>
            {h.host}
          </span>
        </div>
      ))}
    </div>
    <div className='flex gap-2.5'>
      <Button variant='secondary' className='h-14 w-[140px]' onClick={onNotNow}>
        not now
      </Button>
      <Button className='h-14 flex-1' onClick={onAllow}>
        allow and continue
      </Button>
    </div>
    <span className='text-xs text-fg-dim'>
      each one can be turned off later in everything zafu talks to
    </span>
  </Column>
);

export type StepState = 'done' | 'now' | 'later' | 'turned';

export interface StepRow {
  t: string;
  d?: string;
  at?: number;
  state: StepState;
}

const hhmm = (t?: number) => (t ? new Date(t).toTimeString().slice(0, 5) : '');

const Mark = ({ state }: { state: StepState }) => (
  <span
    className={cn(
      'grid size-[18px] shrink-0 place-items-center',
      state === 'done' && 'text-green',
      state === 'now' && 'text-zigner-gold',
      state === 'turned' && 'text-warn',
    )}
  >
    {state === 'done' ? (
      <span className='i-lucide-check size-[18px]' aria-hidden='true' />
    ) : state === 'now' ? (
      <span
        className='i-zafu-enso size-[18px] animate-spin motion-reduce:animate-none'
        aria-hidden='true'
      />
    ) : state === 'turned' ? (
      <span className='i-ph-arrow-u-up-left size-[16px]' aria-hidden='true' />
    ) : (
      <span className='size-1.5 bg-border-hard' />
    )}
  </span>
);

/** a wait's real steps: what happened, when, and which one is running */
export const StepLines = ({ steps }: { steps: StepRow[] }) => (
  <div className='flex flex-col border border-border-soft bg-elev-1'>
    {steps.map((s, i) => (
      <div
        key={s.t}
        className={cn(
          'flex min-h-14 items-center gap-3.5 px-[18px] py-2.5',
          i && 'border-t border-border-soft',
        )}
      >
        <Mark state={s.state} />
        <span className='flex flex-1 flex-col gap-0.5'>
          <span
            className={cn(
              'text-sm',
              s.state === 'turned'
                ? 'text-warn'
                : s.state === 'later'
                  ? 'text-fg-muted'
                  : 'text-fg-high',
            )}
          >
            {s.t}
          </span>
          {s.d && <span className='text-xs text-fg-muted'>{s.d}</span>}
        </span>
        <span className='text-xs tabular-nums text-fg-muted'>{hhmm(s.at)}</span>
      </div>
    ))}
  </div>
);

/** a locked wallet: the password, here, then the page picks up where it was */
export const UnlockColumn = ({
  sub,
  unlock,
  onUnlocked,
}: {
  sub: string;
  unlock: (password: string) => Promise<boolean>;
  onUnlocked: () => Promise<void>;
}) => {
  const [pw, setPw] = useState('');
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Column title='unlock zafu' sub={sub}>
      <form
        className='flex flex-col gap-3'
        onSubmit={e => {
          e.preventDefault();
          setBusy(true);
          void (async () => {
            if (await unlock(pw)) {
              await onUnlocked();
            } else {
              setWrong(true);
            }
            setBusy(false);
          })();
        }}
      >
        <Input
          type='password'
          autoFocus
          value={pw}
          placeholder='password'
          onChange={e => setPw(e.target.value)}
        />
        {wrong && (
          <span className='text-xs text-warn'>that doesn't match · please try again, slowly</span>
        )}
        <Button type='submit' className='h-14' loading={busy}>
          unlock
        </Button>
      </form>
    </Column>
  );
};
