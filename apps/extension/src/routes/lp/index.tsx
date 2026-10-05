/**
 * lp.html: zec liquidity on THORChain, in a full tab (canvas row "ZEC
 * liquidity"). One shell like buy.html: the art, the column for where things
 * stand, and the live data panel that names each source and its age. Reads
 * and the flight run only while this tab is visible; a closed tab asks
 * nothing of anyone, and an add or take-out picks up when it opens again.
 */

import { useEffect, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@repo/ui/components/ui/button';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { ScrollShell, type ScrollArt } from '../../components/scroll-shell';
import { Column, UnlockColumn, useNow } from '../../components/scroll-page';
import { usePasswordGate } from '../../hooks/password-gate';
import { isDone } from '../../lp/flight';
import { zecText } from '../../lp/math';
import {
  cancelAndShieldBack,
  continueFlight,
  init,
  openSheet,
  positionOf,
  show,
  startAdd,
  startWithdraw,
  tick,
  unlock,
  type LpState,
} from './store';
import {
  AddScreen,
  BlockedScreen,
  EgressScreen,
  FirstScreen,
  PositionScreen,
  short,
  TrackScreen,
  TwoSidedScreen,
  useLp,
  WithdrawScreen,
} from './screens';
import { Panel } from './panel';

type Screen =
  | 'loading'
  | 'locked'
  | 'cannot'
  | 'first'
  | 'egress'
  | 'blocked'
  | 'track'
  | 'add'
  | 'position'
  | 'withdraw'
  | 'twoSided';

export const screenOf = (s: LpState): Screen =>
  s.phase !== 'ready'
    ? s.phase
    : s.blocked
      ? 'blocked'
      : s.intro
        ? s.intro
        : s.flight && !s.view
          ? 'track'
          : (s.view ?? (positionOf(s) ? 'position' : 'add'));

const artOf = (s: Screen): ScrollArt =>
  s === 'first' || s === 'egress' || s === 'add' || s === 'locked'
    ? 'bamboo'
    : s === 'track' || s === 'blocked'
      ? 'enso'
      : s === 'twoSided'
        ? 'samurai'
        : 'castle';

const BACK: Partial<Record<Screen, LpState['view']>> = {
  withdraw: 'position',
  twoSided: 'add',
};

export const LpPage = () => {
  const screen = useLp(screenOf);
  const flight = useLp(s => s.flight);
  const hasPos = useLp(s => !!positionOf(s));
  const { requestAuth, PasswordModal } = usePasswordGate();

  useEffect(() => {
    void init();
    // reads and the flight move when the tab is shown and every 15 s while it stays shown
    const turn = () => document.visibilityState === 'visible' && void tick();
    document.addEventListener('visibilitychange', turn);
    const id = setInterval(turn, 15_000);
    return () => {
      document.removeEventListener('visibilitychange', turn);
      clearInterval(id);
    };
  }, []);

  const confirm = (go: () => Promise<void>) => async () => {
    if (await requestAuth()) {
      await go();
    }
  };

  const step: readonly [number, number, string] | undefined =
    screen === 'add'
      ? [1, 3, 'amount']
      : screen === 'track' && flight
        ? flight.kind === 'add'
          ? isDone(flight)
            ? [3, 3, 'in the pool']
            : [2, 3, 'send']
          : isDone(flight)
            ? [3, 3, 'back']
            : [2, 3, 'send']
        : screen === 'withdraw'
          ? [1, 3, 'part']
          : undefined;
  const back =
    screen === 'egress'
      ? () => show(null)
      : screen === 'add' && hasPos
        ? () => show('position')
        : BACK[screen] !== undefined
          ? () => show(BACK[screen]!)
          : undefined;

  const column: Record<Screen, () => ReactNode> = {
    loading: () => null,
    locked: () => (
      <UnlockColumn
        sub='your liquidity waits where you left it.'
        unlock={unlock}
        onUnlocked={init}
      />
    ),
    cannot: () => (
      <Column title='zec liquidity'>
        <p className='text-sm text-fg-muted'>
          liquidity needs a wallet whose recovery phrase is on this computer. please choose one in
          zafu.
        </p>
      </Column>
    ),
    first: () => <FirstScreen />,
    egress: () => <EgressScreen />,
    blocked: () => <BlockedScreen />,
    track: () => (
      <TrackScreen
        onContinue={() => void confirm(continueFlight)()}
        onCancel={() => void confirm(cancelAndShieldBack)()}
      />
    ),
    add: () => <AddScreen onAdd={() => void confirm(startAdd)()} />,
    position: () => <PositionScreen />,
    withdraw: () => <WithdrawScreen onOut={() => void confirm(startWithdraw)()} />,
    twoSided: () => <TwoSidedScreen />,
  };

  return (
    <ScrollShell
      art={artOf(screen)}
      label='zec liquidity'
      aside='w-[360px]'
      back={back}
      step={step}
    >
      {PasswordModal}
      <div className='flex flex-1 items-stretch gap-12 pt-3'>
        <div className='flex w-[480px] max-w-full shrink-0 flex-col justify-center'>
          {column[screen]()}
        </div>
        {screen !== 'loading' && screen !== 'locked' && screen !== 'cannot' && (
          <Panel screen={screen} />
        )}
      </div>
      <Sheets />
    </ScrollShell>
  );
};

/** LpPublic and LpHistory */
const Sheets = () => {
  const { sheet, address, mid } = useLp(
    useShallow(s => ({ sheet: s.sheet, address: s.lp?.address, mid: s.mid })),
  );
  const now = useNow();
  const close = () => openSheet(null);
  const rows = mid?.history ?? [];
  return (
    <>
      <Sheet
        open={sheet === 'public'}
        onOpenChange={o => !o && close()}
        title='a public address'
        className='mx-auto max-w-[560px]'
      >
        <p className='text-[13px] leading-relaxed text-fg'>
          this address and its share of the pool are public, and linked. your shielded zec stays
          private.
        </p>
        <Button className='h-[52px]' onClick={close}>
          understood
        </Button>
      </Sheet>
      <Sheet
        open={sheet === 'history'}
        onOpenChange={o => !o && close()}
        title='history of this address'
        className='mx-auto max-w-[560px]'
      >
        <span className='text-xs text-fg-muted'>
          <span className='font-mono normal-case'>{short(address)}</span>
          {mid
            ? ` · midgard · ${Math.max(0, Math.round((now - mid.at) / 1000))} s ago`
            : ' · midgard is off'}
        </span>
        <div className='flex flex-col divide-y divide-border-soft border border-border-soft'>
          {rows.length === 0 && (
            <span className='px-4 py-4 text-sm text-fg-muted'>nothing on this address yet</span>
          )}
          {rows.map(h => (
            <div
              key={`${h.txid}-${h.kind}`}
              className='flex h-[58px] items-center gap-3.5 bg-elev-1 px-4'
            >
              <span
                className={
                  h.kind === 'add'
                    ? 'size-2 shrink-0 bg-zigner-gold'
                    : h.kind === 'refund'
                      ? 'size-2 shrink-0 bg-warn'
                      : 'size-2 shrink-0 bg-fg-muted'
                }
              />
              <span className='flex flex-1 flex-col gap-1'>
                <span className='text-sm text-fg-high'>
                  {h.kind === 'add'
                    ? 'added to the pool'
                    : h.kind === 'withdraw'
                      ? 'taken out'
                      : h.kind === 'refund'
                        ? 'sent back'
                        : 'other'}
                </span>
                <span className='text-[11px] text-fg-muted'>
                  {new Date(h.at)
                    .toLocaleString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: false,
                    })
                    .toLowerCase()}
                  {h.memo && ` · memo ${h.memo}`}
                  {h.txid && ` · tx ${h.txid.slice(0, 4)}…${h.txid.slice(-4)}`}
                  {h.reason && ` · ${h.reason}`}
                </span>
              </span>
              <span
                className={
                  h.kind === 'refund' ? 'text-[13px] text-warn' : 'text-[13px] text-fg-high'
                }
              >
                {h.kind === 'add' ? '+' : ''}
                {zecText(h.zat)}
              </span>
            </div>
          ))}
        </div>
        <Button className='h-[52px]' onClick={close}>
          close
        </Button>
      </Sheet>
    </>
  );
};
