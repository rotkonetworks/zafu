/**
 * A thorchain swap out of zec, in flight (board SwapU-Tracker): the legs the
 * person confirmed once, where they stand, and the way out. Nothing here asks
 * to go on; the run (state/swap/thor-out) carries on while zafu is open, and
 * the person can leave at any point. A zigner wallet's one device round
 * (the move and the swap together) shows here.
 */

import { useEffect } from 'react';
import { useStore as useZustand } from 'zustand';
import { cn } from '@repo/ui/lib/utils';
import { Button } from '@repo/ui/components/ui/button';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { Sensitive } from '../../../components/sensitive';
import { ScreenHeader } from '../../../components/screen-header';
import { ZignerRoundAction, ZignerRoundView } from '../../../components/zigner-round-view';
import { runs, type Run } from '../../../state/swap/thor-out';
import { swapRound } from '../../../state/swap/thor-legs';
import { fromUnits } from '../../../state/swap/provider';
import { Footer, Main, Mark, Strip, shortAddress } from '../send/send-ui';

const zec = (zat: bigint) => fromUnits(zat, 8);

/** the legs in order, and which one a run is on */
const LEGS = ["move zec to the swap's address", 'waiting for a block', 'send to the vault'];
const ON: Record<'moving' | 'funding' | 'paying', number> = { moving: 0, funding: 1, paying: 2 };

/** what a held-up swap says: the person's money is always placed for them */
const heldLine = (run: Run, tAddress: string) =>
  run.at === 'stopped'
    ? run.error
    : run.at === 'held' && run.late
      ? "the move didn't reach a block in time · nothing left your wallet"
      : run.at === 'held' && run.moved
        ? 'the move is in · the deposit waits for your signature'
        : run.moved
          ? `the zec sits on this swap's address, ${shortAddress(tAddress)} · nothing went to the vault`
          : run.at === 'expired'
            ? 'nothing was moved · a fresh price is a tap away'
            : 'nothing was sent';

export const ThorOutTracker = ({
  id,
  storeId,
  amountZat,
  tAddress,
  vault,
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
  /** the route's name, for the deposit leg */
  vault: string;
  onSent: (txid: string) => void;
  onLeave: () => void;
  /** a held run: carry on (a hot wallet unlocks again) */
  onResume: () => void;
  /** ask a fresh price; the swap keeps its address, so moved zec is used as it is */
  onAgain: () => void;
  /** let the swap go: home, where moved zec can be shielded back */
  onDrop: () => void;
}) => {
  const run = useZustand(runs, r => r[id]);
  const round = swapRound(id, storeId);
  const shown = useZustand(round.store, r => r.shown);
  const sentTxid = run?.at === 'sent' ? run.txid : undefined;
  useEffect(() => {
    if (sentTxid) {
      onSent(sentTxid);
    }
  }, [sentTxid]);

  const strip = (
    <Strip>
      <Sensitive>{`${zec(amountZat)} zec · ${vault}`}</Sensitive>
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
    const title = { stopped: 'swap stopped', expired: 'the price ran out', held: 'swap' }[run.at];
    return (
      <div className='flex h-full flex-col bg-canvas'>
        <ScreenHeader title={title} onBack={onLeave} />
        {strip}
        <Main className='pt-5'>
          <StatusSlot
            tone={run.at === 'stopped' ? 'warn' : 'info'}
            icon={run.at === 'stopped' ? 'i-ph-warning' : 'i-ph-clock'}
          >
            {heldLine(run, tAddress)}
          </StatusSlot>
        </Main>
        <Footer>
          {run.at === 'held' ? (
            <>
              <Button variant='secondary' onClick={onLeave} className='w-[110px]'>
                not now
              </Button>
              <Button onClick={onResume} className='grow'>
                sign the swap
              </Button>
            </>
          ) : run.moved ? (
            <>
              <Button variant='secondary' onClick={onDrop} className='grow'>
                shield it back
              </Button>
              <Button onClick={onAgain} className='grow'>
                swap again
              </Button>
            </>
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
  const legs = run?.at === 'paying' && !run.moved ? LEGS.slice(2) : LEGS;
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
                {name === LEGS[2] ? `send to the ${vault} vault` : name}
              </span>
            </li>
          ))}
        </ol>
        <p className='text-[11px] text-fg-muted'>
          public · the amount, the vault and this swap's address show
        </p>
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
