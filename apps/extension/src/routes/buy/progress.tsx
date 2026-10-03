/**
 * The waits, alive and honest: every line is a real step, every clock a real
 * one (when the step landed, how long the running one has taken, against
 * what the service itself says is usual). The tracker follows the buy from
 * paid to shielded; done shows the real amount beside the estimate.
 */

import { Button } from '@repo/ui/components/ui/button';
import { cn } from '@repo/ui/lib/utils';
import { useShallow } from 'zustand/react/shallow';
import { payApp } from '../../buy/apps';
import { clock, loadOffer, type OpenBuy } from '../../buy/machine';
import { Column, useBuy, useNow } from './ui';
import { money, usdc2 } from '../../buy/fees';
import { zec4 } from './amount';
import { finish, swapNow, type BuyState, type Step } from './store';

const hhmm = (t?: number) => (t ? new Date(t).toTimeString().slice(0, 5) : '');

const Mark = ({ state }: { state: 'done' | 'now' | 'later' | 'bad' }) => (
  <span
    className={cn(
      'grid size-[18px] shrink-0 place-items-center',
      state === 'done' && 'text-green',
      state === 'now' && 'text-zigner-gold',
      state === 'bad' && 'text-warn',
    )}
  >
    {state === 'done' ? (
      <span className='i-lucide-check size-[18px]' aria-hidden='true' />
    ) : state === 'now' ? (
      <span
        className='i-zafu-enso size-[18px] animate-spin motion-reduce:animate-none'
        aria-hidden='true'
      />
    ) : state === 'bad' ? (
      <span className='i-ph-warning size-[16px]' aria-hidden='true' />
    ) : (
      <span className='size-1.5 bg-border-hard' />
    )}
  </span>
);

const Lines = ({ steps }: { steps: Step[] }) => (
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
          <span className={cn('text-sm', s.state === 'later' ? 'text-fg-muted' : 'text-fg-high')}>
            {s.t}
          </span>
          {s.d && <span className='text-xs text-fg-muted'>{s.d}</span>}
        </span>
        <span className='text-xs tabular-nums text-fg-muted'>{hhmm(s.at)}</span>
      </div>
    ))}
  </div>
);

/** a wait on one service: its steps, and its clock against what is usual */
export const ProgressScreen = ({ title, usually }: { title: string; usually: string }) => {
  const { steps, since, error } = useBuy(
    useShallow((s: BuyState) => ({ steps: s.steps, since: s.since, error: s.error })),
  );
  const now = useNow();
  return (
    <Column title={title}>
      <div className='flex items-baseline gap-3'>
        <span className='font-display text-[34px] tabular-nums text-fg-high'>
          {since ? clock(now - since) : '0:00'}
        </span>
        <span className='text-xs text-fg-muted'>{usually}</span>
      </div>
      <Lines steps={steps} />
      {error && <span className='text-xs text-warn'>{error}</span>}
    </Column>
  );
};

const trackSteps = (b: OpenBuy, now: number): (Step & { bad?: boolean })[] => {
  const o = loadOffer(b.offer);
  const app = payApp(b.app);
  const s = b.stage;
  const est = b.near?.timeEstimate;
  const swapping = b.at.swapping;
  return [
    {
      t: `paid ${o.handle}`,
      d: `${money(o.fiat, b.currency)} on ${app?.name}`,
      at: b.at.confirming,
      state: 'done',
    },
    {
      t: 'confirmed by peer',
      d:
        b.at.confirming && b.at.released
          ? `took ${clock(b.at.released - b.at.confirming)}`
          : undefined,
      at: b.at.released,
      state: 'done',
    },
    {
      t: 'usdc in your zafu base account',
      d: `${usdc2(o.net)} usdc${b.fulfillTx ? ` · base tx ${b.fulfillTx.slice(0, 6)}…${b.fulfillTx.slice(-4)}` : ''}`,
      at: b.at.released,
      state: 'done',
    },
    s === 'refunded'
      ? {
          t: 'near returned the usdc',
          d: 'it is back in your zafu base account',
          at: b.at.refunded,
          state: 'done',
          bad: true,
        }
      : {
          t: 'swapping to zec',
          d: swapping
            ? `near intents · ${clock(now - swapping)}${est ? ` of ~${Math.max(1, Math.round(est / 60))} min` : ''}`
            : 'a fresh near quote',
          at: b.at.done,
          state: s === 'done' ? 'done' : 'now',
        },
    {
      t: 'shielded',
      d:
        s === 'done'
          ? `${zec4(b.arrived ?? b.near?.amountOut ?? 0)} zec sent to your wallet`
          : 'the next zcash block · about 75 s apart',
      at: b.at.done,
      state: s === 'done' ? 'done' : 'later',
    },
  ];
};

export const TrackScreen = () => {
  const { buy, error } = useBuy(useShallow((s: BuyState) => ({ buy: s.buy, error: s.error })));
  const now = useNow();
  if (!buy) {
    return null;
  }
  const refund = buy.stage === 'refunded';
  const steps = trackSteps(buy, now);
  return (
    <Column title={refund ? 'the swap did not go through' : 'your zec is on its way'}>
      <div className='flex flex-col border border-border-soft bg-elev-1'>
        {steps.map((s, i) => (
          <div
            key={s.t}
            className={cn(
              'flex min-h-14 items-center gap-3.5 px-[18px] py-2.5',
              i && 'border-t border-border-soft',
            )}
          >
            <Mark state={s.bad ? 'bad' : s.state} />
            <span className='flex flex-1 flex-col gap-0.5'>
              <span
                className={cn(
                  'text-sm',
                  s.bad ? 'text-warn' : s.state === 'later' ? 'text-fg-muted' : 'text-fg-high',
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
      {error && <span className='text-xs text-warn'>{error}</span>}
      {refund ? (
        <>
          <span className='text-xs text-fg-muted'>
            {usdc2(loadOffer(buy.offer).net)} usdc waits in your zafu base account. it is yours.
          </span>
          <div className='flex gap-2.5'>
            <Button variant='secondary' className='h-14 w-[160px]' onClick={() => void finish()}>
              keep as usdc
            </Button>
            <Button className='h-14 flex-1' onClick={() => void swapNow()}>
              swap to zec again
            </Button>
          </div>
        </>
      ) : (
        <>
          <span className='text-xs text-fg-muted'>
            safe to close · zafu picks this up when you open it again
          </span>
          <Button className='h-14' onClick={() => window.close()}>
            back to zafu
          </Button>
        </>
      )}
    </Column>
  );
};

export const DoneScreen = () => {
  const buy = useBuy(s => s.buy);
  if (!buy) {
    return null;
  }
  const o = loadOffer(buy.offer);
  return (
    <div className='flex flex-col items-start gap-5'>
      <span className='font-display text-5xl text-hanko'>済</span>
      <span className='flex items-baseline gap-2.5'>
        <span className='font-display text-[64px] text-fg-high'>
          {zec4(buy.arrived ?? buy.near?.amountOut ?? 0)}
        </span>
        <span className='text-xl text-zigner-gold'>zec</span>
      </span>
      <span className='flex items-center gap-2 text-sm text-fg-muted'>
        <span className='i-lucide-shield size-3.5' aria-hidden='true' />
        sent shielded · {buy.walletLabel ?? 'your wallet'}
      </span>
      <div className='flex w-full flex-col gap-2 border-t border-border-soft pt-4 text-[13px]'>
        <span className='flex justify-between'>
          <span className='text-fg-muted'>you paid</span>
          {money(o.fiat, buy.currency)} on {payApp(buy.app)?.name}
        </span>
        {buy.near && (
          <span className='flex justify-between'>
            <span className='text-fg-muted'>estimate was</span>
            {zec4(buy.near.amountOut)} zec
          </span>
        )}
      </div>
      <div className='flex w-full gap-2.5'>
        <Button variant='secondary' className='h-14 w-[160px]' onClick={() => void finish()}>
          buy again
        </Button>
        <Button className='h-14 flex-1' onClick={() => void finish().then(() => window.close())}>
          open zafu
        </Button>
      </div>
    </div>
  );
};
