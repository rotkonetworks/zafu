/**
 * buy.html: buy zec with cash, through Peer, in a full tab (canvas row
 * "Buy zec"). One shell; the column shows the screen for where the buy
 * stands, the ticket on the right never leaves. Checks run only while this
 * tab is visible; nothing runs anywhere while it is closed.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { ScrollShell, type ScrollArt } from '../../components/scroll-shell';
import { allowEgress, check, init, unlock, type BuyState } from './store';
import { Column, useBuy } from './ui';
import { AmountScreen, Sheets, Ticket } from './amount';
import { AskScreen, ChooseScreen, FailedScreen, GasScreen, LapsedScreen, PayScreen } from './pay';
import { DoneScreen, ProgressScreen, TrackScreen } from './progress';

type Screen =
  | 'loading'
  | 'locked'
  | 'cannot'
  | 'egress'
  | 'amount'
  | 'gas'
  | 'reserve'
  | 'pay'
  | 'ask'
  | 'reading'
  | 'choose'
  | 'verify'
  | 'failed'
  | 'lapsed'
  | 'track'
  | 'refund'
  | 'done';

const screenOf = (s: BuyState): Screen =>
  s.phase !== 'ready'
    ? s.phase
    : s.egress !== 'ok'
      ? 'egress'
      : (s.overlay ??
        (!s.buy
          ? 'amount'
          : s.buy.stage === 'reserving'
            ? 'reserve'
            : s.buy.stage === 'released' || s.buy.stage === 'swapping'
              ? 'track'
              : s.buy.stage === 'refunded'
                ? 'refund'
                : s.buy.stage === 'done'
                  ? 'done'
                  : s.buy.stage === 'lapsed'
                    ? 'lapsed'
                    : 'pay'));

const STEP: Partial<Record<Screen, readonly [number, number, string]>> = {
  amount: [1, 4, 'amount'],
  gas: [2, 4, 'pay'],
  reserve: [2, 4, 'pay'],
  pay: [2, 4, 'pay'],
  ask: [3, 4, 'confirm'],
  reading: [3, 4, 'confirm'],
  choose: [3, 4, 'confirm'],
  verify: [3, 4, 'confirm'],
  failed: [3, 4, 'confirm'],
  lapsed: [3, 4, 'confirm'],
  track: [4, 4, 'arrive'],
  refund: [4, 4, 'arrive'],
};

const artOf = (s: Screen): ScrollArt =>
  s === 'egress' || s === 'amount' || s === 'locked'
    ? 'bamboo'
    : s === 'gas' || s === 'reserve' || s === 'pay'
      ? 'samurai'
      : s === 'done'
        ? 'castle'
        : 'enso';

const SCREENS: Record<Screen, () => ReactNode> = {
  loading: () => null,
  locked: () => <Unlock />,
  cannot: () => (
    <Column title='buy zec'>
      <p className='text-sm text-fg-muted'>
        buying needs a wallet whose recovery phrase is on this computer. please choose one in zafu.
      </p>
    </Column>
  ),
  egress: () => <AskOnce />,
  amount: () => <AmountScreen />,
  gas: () => <GasScreen />,
  reserve: () => <ProgressScreen title='holding the seller' usually='usually a few seconds' />,
  pay: () => <PayScreen />,
  ask: () => <AskScreen />,
  reading: () => <ProgressScreen title='reading your payment' usually='usually under 30 seconds' />,
  choose: () => <ChooseScreen />,
  verify: () => <ProgressScreen title='confirming your payment' usually='usually under a minute' />,
  failed: () => <FailedScreen />,
  lapsed: () => <LapsedScreen />,
  track: () => <TrackScreen />,
  refund: () => <TrackScreen />,
  done: () => <DoneScreen />,
};

const NO_TICKET = new Set<Screen>(['loading', 'locked', 'cannot', 'egress']);

export const BuyPage = () => {
  const screen = useBuy(screenOf);
  const unsupported = useBuy(s => s.quotes?.kind === 'unsupported');

  useEffect(() => {
    void init();
    // a buy in flight is checked when the tab is shown and every 15 s while
    // it stays shown; a hidden or closed tab asks nothing of anyone
    const tick = () => document.visibilityState === 'visible' && void check();
    document.addEventListener('visibilitychange', tick);
    const id = setInterval(tick, 15_000);
    return () => {
      document.removeEventListener('visibilitychange', tick);
      clearInterval(id);
    };
  }, []);

  return (
    <ScrollShell art={artOf(screen)} label='buy zec' aside='w-[400px]' step={STEP[screen]}>
      <div className='flex flex-1 items-center gap-[52px]'>
        <div className='w-[500px] max-w-full'>{SCREENS[screen]()}</div>
        {!NO_TICKET.has(screen) && !unsupported && <Ticket />}
      </div>
      <Sheets />
    </ScrollShell>
  );
};

/** Buy 0: the four services, asked once, together */
const HOSTS = [
  {
    mark: 'p',
    name: 'peer',
    does: 'finds a seller and checks your payment',
    host: 'api.zkp2p.xyz\nattestation-service.zkp2p.xyz\nindexer.zkp2p.xyz',
    c: 'text-zigner-gold',
  },
  {
    mark: 'b',
    name: 'base',
    does: "where the seller's usdc is held for you",
    host: 'mainnet.base.org',
    c: 'text-info',
  },
  {
    mark: 'n',
    name: 'near intents',
    does: 'swaps the usdc into shielded zec',
    host: '1click.chaindefuser.com',
    c: 'text-teal',
  },
  {
    mark: 'z',
    name: 'zafu sponsor',
    does: 'covers your base gas',
    host: 'sponsor.zafu.pro',
    c: 'text-hanko',
  },
];

const AskOnce = () => (
  <Column title='before we begin' sub='buying talks to these, and only while you buy.'>
    <div className='flex flex-col border border-border-soft bg-elev-1'>
      {HOSTS.map(h => (
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
      <Button variant='secondary' className='h-14 w-[140px]' onClick={() => window.close()}>
        not now
      </Button>
      <Button className='h-14 flex-1' onClick={() => void allowEgress()}>
        allow and continue
      </Button>
    </div>
    <span className='text-xs text-fg-dim'>
      each one can be turned off later in everything zafu talks to
    </span>
  </Column>
);

/** a locked wallet: the password, here, then the buy picks up */
const Unlock = () => {
  const [pw, setPw] = useState('');
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Column title='unlock zafu' sub='your buy waits where you left it.'>
      <form
        className='flex flex-col gap-3'
        onSubmit={e => {
          e.preventDefault();
          setBusy(true);
          void (async () => {
            if (await unlock(pw)) {
              await init();
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
        {wrong && <span className='text-xs text-warn'>that doesn't match - please try again</span>}
        <Button type='submit' className='h-14' loading={busy}>
          unlock
        </Button>
      </form>
    </Column>
  );
};
