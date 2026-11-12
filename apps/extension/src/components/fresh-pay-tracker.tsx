/**
 * A payment from a fresh transparent address, in flight (board
 * SwapU-Tracker): the legs the person confirmed once, where they stand, and
 * the way out. Nothing here asks to go on; the run (zcash/pay/via-fresh)
 * carries on while zafu is open, and the person can leave at any point. A
 * zigner wallet's one device round (the move and the payment together)
 * shows here. What it is for (a swap, a tex payment) is only its words.
 */

import { useEffect } from 'react';
import { useStore as useZustand } from 'zustand';
import { cn } from '@repo/ui/lib/utils';
import { Button } from '@repo/ui/components/ui/button';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { Sensitive } from './sensitive';
import { ScreenHeader } from './screen-header';
import { ZignerRoundAction, ZignerRoundView } from './zigner-round-view';
import { runs, type Run } from '../zcash/pay/via-fresh';
import { payRound } from '../zcash/pay/legs';
import { fromUnits } from '../state/swap/provider';
import { Addr, Footer, Main, Mark, Strip } from '../routes/popup/send/send-ui';

const zec = (zat: bigint) => fromUnits(zat, 8);

/** what the tracker calls things; a swap and a tex payment differ only here */
export interface TrackerWords {
  /** the screen's title, and 'x stopped' */
  noun: string;
  /** the first leg */
  move: string;
  /** the last leg */
  pay: string;
  /** where moved zec waits, before the address */
  sits: string;
  /** what didn't happen yet, after the address */
  notPaid: string;
  /** what the held payment waits for */
  held: string;
  /** the resume button */
  resume: string;
  /** who sees what */
  shows: string;
}

const ON: Record<'moving' | 'funding' | 'paying', number> = { moving: 0, funding: 1, paying: 2 };

/** what a held-up payment says: the person's money is always placed for them */
const heldLine = (run: Run, tAddress: string, w: TrackerWords) =>
  run.at === 'stopped' ? (
    run.error
  ) : run.at === 'held' && run.late ? (
    "the move didn't reach a block in time · nothing left your wallet"
  ) : run.at === 'held' && run.moved ? (
    w.held
  ) : run.moved ? (
    <>
      {w.sits} <Addr>{tAddress}</Addr> · {w.notPaid}
    </>
  ) : run.at === 'expired' ? (
    'nothing was moved · a fresh price is a tap away'
  ) : (
    'nothing was sent'
  );

export const FreshPayTracker = ({
  id,
  storeId,
  amountZat,
  tAddress,
  to,
  words,
  onSent,
  onLeave,
  onResume,
  onAgain,
  onDrop,
}: {
  id: string;
  storeId: string;
  amountZat: bigint;
  tAddress: string;
  /** who is paid, on the strip */
  to: string;
  words: TrackerWords;
  onSent: (txid: string) => void;
  onLeave: () => void;
  /** a held run: carry on (a hot wallet unlocks again) */
  onResume: () => void;
  /** ask a fresh price, keeping the address, so moved zec is used as it is; none for a payment with no price */
  onAgain?: () => void;
  /** let the payment go: home, where moved zec can be shielded back */
  onDrop: () => void;
}) => {
  const run = useZustand(runs, r => r[id]);
  const round = payRound(id, storeId);
  const shown = useZustand(round.store, r => r.shown);
  const sentTxid = run?.at === 'sent' ? run.txid : undefined;
  useEffect(() => {
    if (sentTxid) {
      onSent(sentTxid);
    }
  }, [sentTxid]);

  const strip = (
    <Strip>
      <Sensitive>{`${zec(amountZat)} zec · ${to}`}</Sensitive>
    </Strip>
  );

  // the device's round (one, for the move and the swap): its qr, then the camera
  if (shown) {
    return (
      <div className='flex h-full flex-col bg-canvas'>
        <ScreenHeader title='sign on zigner' onBack={() => round.cancel()} />
        <Strip>{shown.label}</Strip>
        <Main className='items-center gap-3 px-5 pt-4'>
          <ZignerRoundView round={round} pinned />
        </Main>
        <Footer>
          <ZignerRoundAction round={round} />
        </Footer>
      </div>
    );
  }

  if (run && (run.at === 'stopped' || run.at === 'expired' || run.at === 'held')) {
    const title = {
      stopped: `${words.noun} stopped`,
      expired: 'the price ran out',
      held: words.noun,
    }[run.at];
    return (
      <div className='flex h-full flex-col bg-canvas'>
        <ScreenHeader title={title} onBack={onLeave} />
        {strip}
        <Main className='pt-5'>
          <StatusSlot
            tone={run.at === 'stopped' ? 'warn' : 'info'}
            icon={run.at === 'stopped' ? 'i-ph-warning' : 'i-ph-clock'}
          >
            {heldLine(run, tAddress, words)}
          </StatusSlot>
        </Main>
        <Footer>
          {run.at === 'held' ? (
            <>
              <Button variant='secondary' onClick={onLeave} className='w-[110px]'>
                not now
              </Button>
              <Button onClick={onResume} className='grow'>
                {words.resume}
              </Button>
            </>
          ) : run.moved && onAgain ? (
            <>
              <Button variant='secondary' onClick={onDrop} className='grow'>
                shield it back
              </Button>
              <Button onClick={onAgain} className='grow'>
                {words.noun} again
              </Button>
            </>
          ) : run.moved || !onAgain ? (
            <Button variant='secondary' onClick={onDrop} className='w-full'>
              {run.moved ? 'shield it back' : 'back to wallet'}
            </Button>
          ) : (
            <>
              <Button variant='secondary' onClick={onDrop} className='w-[110px]'>
                not now
              </Button>
              <Button onClick={onAgain} className='grow'>
                get a new price
              </Button>
            </>
          )}
        </Footer>
      </div>
    );
  }

  // a deposit from an address that was already funded has one leg
  const on = run && run.at !== 'sent' ? ON[run.at] : 0;
  const all = [words.move, 'waiting for a block', words.pay];
  const legs = run?.at === 'paying' && !run.moved ? all.slice(2) : all;
  const at = legs.length === 1 ? 0 : on;
  return (
    <div className='flex h-full flex-col bg-canvas'>
      <ScreenHeader title='swap' onBack={onLeave} />
      {strip}
      <Main className='gap-[18px] pt-5'>
        <ol className='flex flex-col divide-y divide-border-soft border border-border-soft bg-elev-1'>
          {legs.map((name, i) => (
            <li key={name} className='flex h-11 items-center gap-3 px-3.5'>
              <Mark state={!run ? 'wait' : i < at ? 'done' : i === at ? 'now' : 'wait'} />
              <span className={cn('grow text-[13px]', i > at ? 'text-fg-muted' : 'text-fg-high')}>
                {name}
              </span>
            </li>
          ))}
        </ol>
        <p className='text-[11px] text-fg-muted'>{words.shows}</p>
      </Main>
      <Footer className='flex-col'>
        <span className='flex h-[18px] items-center justify-center text-[11px] text-fg-muted'>
          you can leave · it carries on whenever zafu is open
        </span>
        <Button variant='secondary' onClick={onLeave} className='h-11 w-full'>
          back to wallet
        </Button>
      </Footer>
    </div>
  );
};
