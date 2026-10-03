/**
 * Buy 1 (amount, payment app, seller), the order ticket that stays on the
 * right, and the sheets that rise over the column.
 */

import { Button } from '@repo/ui/components/ui/button';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { cn } from '@repo/ui/lib/utils';
import { useShallow } from 'zustand/react/shallow';
import { appNote, CURRENCIES, PAY_APPS, payApp } from '../../buy/apps';
import { fiatUnits, rate3, ticketRows, usdc2, type Offer } from '../../buy/fees';
import { loadOffer } from '../../buy/machine';
import { peerBuyUrl } from '../../config/ramps';
import { Column, useBuy, useNow } from './ui';
import {
  openSheet,
  requote,
  reserveNow,
  setAmount,
  setApp,
  setCurrency,
  setOffer,
  type BuyState,
} from './store';

const SYM: Record<string, string> = {
  usd: '$',
  eur: '€',
  gbp: '£',
  cad: '$',
  brl: 'r$',
  ars: '$',
  inr: '₹',
};
export const money = (fiat: bigint | number, cur: string) =>
  `${SYM[cur] ?? ''}${(typeof fiat === 'bigint' ? Number(fiat) / 1e6 : fiat).toLocaleString(
    'en-US',
    {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    },
  )}${SYM[cur] ? '' : ` ${cur}`}`;
export const zec4 = (units: bigint | string | number) => (Number(units) / 1e8).toFixed(4);
const CHIPS = ['50', '100', '250', '500'];

const RowButton = ({
  mark,
  label,
  value,
  note,
  onClick,
  first,
}: {
  mark: string;
  label: string;
  value: string;
  note?: string;
  onClick: () => void;
  first?: boolean;
}) => (
  <button
    type='button'
    onClick={onClick}
    className={cn(
      'flex h-16 items-center gap-3.5 bg-elev-1 px-[18px] text-left transition-colors hover:bg-elev-2',
      !first && 'border-t border-border-soft',
    )}
  >
    <span className='grid size-8 shrink-0 place-items-center border border-border-hard bg-elev-2 text-sm text-fg-high'>
      {mark}
    </span>
    <span className='flex flex-1 flex-col gap-1'>
      <span className='text-xs text-fg-muted'>{label}</span>
      <span className='text-[15px] text-fg-high'>{value}</span>
    </span>
    {note && <span className='text-xs text-fg-muted'>{note}</span>}
    <span className='i-lucide-chevron-right size-3.5 text-fg-muted' aria-hidden='true' />
  </button>
);

/** the rate's age, a real clock from when peer answered */
const QuoteAge = ({ at }: { at: number }) => {
  const now = useNow();
  return (
    <span className='flex items-center gap-1.5 text-[11px] text-fg-dim'>
      <span className='size-1.5 animate-pulse bg-green motion-reduce:animate-none' />
      rate checked {Math.max(0, Math.round((now - at) / 1000))} s ago
    </span>
  );
};

export const AmountScreen = () => {
  const s = useBuy(
    useShallow((s: BuyState) => ({
      amount: s.amount,
      currency: s.currency,
      appId: s.app,
      quotes: s.quotes,
      quoting: s.quoting,
      estimate: s.estimate,
      firstTime: s.firstTime,
      offerIdx: s.offerIdx,
      base: s.base,
      error: s.error,
    })),
  );
  const app = payApp(s.appId);
  const offer = s.quotes?.kind === 'offers' ? s.quotes.offers[s.offerIdx] : undefined;
  const unsupported = s.quotes?.kind === 'unsupported';
  const limit = s.quotes?.kind === 'limit' ? s.quotes.max : undefined;
  const canGo = !!offer && !s.quoting && !!fiatUnits(s.amount);

  return (
    <Column
      title='buy zec'
      sub={
        s.firstTime &&
        !unsupported &&
        app &&
        `you pay a person on ${app.name}. their usdc becomes shielded zec in your wallet.`
      }
    >
      <div className={cn('border bg-elev-1', limit ? 'border-warn' : 'border-border-soft')}>
        <div className='flex h-[108px] items-center gap-3.5 px-5'>
          <label htmlFor='buyamt' className='sr-only'>
            amount in {s.currency}
          </label>
          <span className='font-display text-[56px] text-fg-muted'>{SYM[s.currency] ?? ''}</span>
          <input
            id='buyamt'
            inputMode='decimal'
            autoFocus
            value={s.amount}
            onChange={e => setAmount(e.target.value)}
            className='h-[72px] min-w-0 flex-1 bg-transparent font-display text-[56px] text-fg-high outline-none'
          />
          <button
            type='button'
            onClick={() => openSheet('cur')}
            className='flex h-9 items-center gap-2 border border-border-hard bg-elev-2 px-3 text-[13px] text-fg-high'
          >
            {s.currency}
            <span className='i-lucide-chevron-down size-3 text-fg-muted' aria-hidden='true' />
          </button>
        </div>
        <div className='flex h-[52px] items-center gap-2 border-t border-border-soft px-5'>
          {CHIPS.map(c => (
            <button
              key={c}
              type='button'
              onClick={() => setAmount(c)}
              className={cn(
                'h-8 border px-3.5 text-[13px]',
                s.amount === c
                  ? 'border-zigner-gold bg-elev-2 text-fg-high'
                  : 'border-border-soft bg-elev-2 text-fg',
              )}
            >
              {SYM[s.currency] ?? ''}
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className='flex h-10 items-center gap-2.5'>
        {unsupported ? (
          <>
            <span className='size-2 shrink-0 bg-fg-muted' />
            <span className='text-[13px]'>
              peer has no sellers for {s.currency} yet. we are sorry.
            </span>
          </>
        ) : limit ? (
          <>
            <span className='size-2 shrink-0 bg-warn' />
            <span className='text-[13px]'>
              the most a {app?.name} seller can fill right now is {money(limit, s.currency)}
            </span>
            <Button
              variant='secondary'
              size='sm'
              className='shrink-0 whitespace-nowrap text-zigner-gold'
              onClick={() => setAmount(String(Number(limit) / 1e6))}
            >
              use {money(limit, s.currency)}
            </Button>
          </>
        ) : (
          <>
            <span
              className={cn(
                'font-display text-[26px] text-fg-high transition-opacity',
                s.quoting && 'opacity-50',
              )}
            >
              ≈ {s.estimate ? zec4(s.estimate.amountOut) : offer ? '…' : '-'}
            </span>
            <span className='text-[15px] text-zigner-gold'>zec</span>
            <span className='text-xs text-fg-muted'>shielded · all fees in</span>
            <span className='flex-1' />
            {s.quotes && s.quotes.kind === 'offers' && <QuoteAge at={s.quotes.at} />}
            {s.quotes?.kind === 'none' && (
              <span className='text-xs text-fg-muted'>no seller for this amount yet</span>
            )}
          </>
        )}
      </div>

      {!unsupported && app && (
        <div className='flex flex-col border border-border-soft'>
          <RowButton
            first
            mark={app.mark}
            label='pay with'
            value={app.name}
            note={app.via}
            onClick={() => openSheet('app')}
          />
          <RowButton
            mark={offer ? offer.handle.slice(0, 2) : '-'}
            label='seller'
            value={
              offer ? `${s.offerIdx === 0 ? 'best rate · ' : ''}${offer.handle}` : 'the best seller'
            }
            note={offer && rate3(offer.rate)}
            onClick={() => openSheet('seller')}
          />
        </div>
      )}

      {s.error && <span className='text-xs text-warn'>{s.error}</span>}

      {unsupported ? (
        <div className='flex gap-2.5'>
          <Button
            variant='secondary'
            className='h-14 w-[200px]'
            onClick={() => window.open(chrome.runtime.getURL('popup.html#/receive'))}
          >
            receive zec instead
          </Button>
          <Button className='h-14 flex-1' onClick={() => openSheet('cur')}>
            choose another currency
          </Button>
        </div>
      ) : (
        <>
          <Button className='h-14' disabled={!canGo} onClick={() => void reserveNow()}>
            continue
          </Button>
          <a
            href={peerBuyUrl({
              currency: s.currency,
              amount: s.amount,
              platform: app?.id,
              recipient: s.base,
            })}
            target='_blank'
            rel='noopener noreferrer'
            className='self-center text-xs text-fg-muted hover:text-fg-high'
          >
            or on peer's site
          </a>
        </>
      )}
    </Column>
  );
};

/** the order, every fee its own line; never leaves the right side */
export const Ticket = () => {
  const s = useBuy(
    useShallow((s: BuyState) => ({
      buy: s.buy,
      quotes: s.quotes,
      offerIdx: s.offerIdx,
      formCurrency: s.currency,
      formApp: s.app,
      estimate: s.estimate,
      gas: s.gas,
      walletLabel: s.walletLabel,
    })),
  );
  const o: Offer | undefined = s.buy
    ? loadOffer(s.buy.offer)
    : s.quotes?.kind === 'offers'
      ? s.quotes.offers[s.offerIdx]
      : undefined;
  const currency = s.buy?.currency ?? s.formCurrency;
  const app = payApp(s.buy?.app ?? s.formApp);
  const stage = s.buy?.stage;
  const state =
    !stage || stage === 'reserving'
      ? ['estimate', 'text-fg-muted']
      : stage === 'pay'
        ? ['held for you', 'text-zigner-gold']
        : stage === 'confirming'
          ? ['paid · confirming', 'text-zigner-gold']
          : stage === 'done'
            ? ['arrived', 'text-green']
            : stage === 'refunded'
              ? ['usdc returned', 'text-warn']
              : stage === 'expired'
                ? ['expired', 'text-fg-muted']
                : ['on its way', 'text-zigner-gold'];
  const near = s.buy?.near;
  const swapCost = near?.cost !== undefined ? BigInt(near.cost) : s.estimate?.cost;
  const get =
    stage === 'done' && s.buy?.arrived
      ? zec4(s.buy.arrived)
      : `≈ ${near ? zec4(near.amountOut) : s.estimate ? zec4(s.estimate.amountOut) : '-'}`;
  const min =
    stage === 'done'
      ? near && `estimate was ≈ ${zec4(near.amountOut)}`
      : stage === 'refunded'
        ? 'the usdc waits for a fresh swap'
        : near
          ? `at least ${zec4(near.minAmountOut)} · near's quote at ${new Date(near.quotedAt).toTimeString().slice(0, 5)}`
          : "at today's zec price · fixed when the usdc arrives";

  if (!o) {
    return <div className='w-[340px]' />;
  }
  return (
    <aside className='flex w-[340px] flex-col border border-border-soft bg-elev-1'>
      <div className='flex h-12 items-center justify-between border-b border-border-soft px-5'>
        <span className='text-xs text-fg-muted'>your order</span>
        <span className={cn('text-xs', state[1])}>{state[0]}</span>
      </div>
      <div className='flex flex-col gap-1 border-b border-border-soft px-5 py-4'>
        <span className='text-xs text-fg-muted'>you pay</span>
        <span className='font-display text-[28px] text-fg-high'>{money(o.fiat, currency)}</span>
        <span className='text-xs text-fg-muted'>
          on {app?.name} · to {s.buy ? o.handle : 'the best seller'}
        </span>
      </div>
      <div className='flex flex-col gap-2.5 border-b border-border-soft px-5 py-4'>
        {ticketRows(
          o,
          currency,
          swapCost,
          s.gas === 'sponsored' ? 'sponsored' : s.gas === 'needs-eth' ? 'needs-eth' : 'unknown',
        ).map(r => (
          <div key={r.k} className='flex items-baseline justify-between gap-3 text-xs'>
            <span className='text-fg-muted'>{r.k}</span>
            <span
              className={cn(
                'tabular text-right',
                r.tone === 'green' ? 'text-green' : r.tone === 'warn' ? 'text-warn' : 'text-fg',
              )}
            >
              {r.struck && <s className='mr-1.5 text-fg-dim'>{r.struck}</s>}
              {r.v}
              {r.note && <span className='ml-1.5 text-green/80'>{r.note}</span>}
            </span>
          </div>
        ))}
      </div>
      <div className='flex flex-col gap-1 px-5 py-4'>
        <span className='text-xs text-fg-muted'>you get</span>
        <span className='flex items-baseline gap-2'>
          <span className='font-display text-[28px] text-fg-high'>{get}</span>
          <span className='text-sm text-zigner-gold'>zec</span>
        </span>
        <span className='text-[11px] text-fg-dim'>{min}</span>
      </div>
      <div className='flex h-11 items-center gap-2 border-t border-border-soft px-5 text-[11px] text-fg-muted'>
        <span className='i-lucide-shield size-3.5' aria-hidden='true' />
        into {s.walletLabel ?? 'your wallet'} · shielded
      </div>
    </aside>
  );
};

const Pick = ({
  on,
  off,
  onClick,
  children,
  first,
}: {
  on: boolean;
  off?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  first?: boolean;
}) => (
  <button
    type='button'
    disabled={off}
    onClick={onClick}
    className={cn(
      'flex h-14 items-center gap-3.5 px-4 text-left transition-colors',
      !first && 'border-t border-border-soft',
      on ? 'bg-elev-2' : 'bg-elev-1 hover:bg-elev-2',
      off && 'opacity-45',
    )}
  >
    {children}
    <span
      className={cn(
        'grid size-4 place-items-center border',
        on ? 'border-zigner-gold' : 'border-border-hard',
      )}
    >
      {on && <span className='size-2 bg-zigner-gold' />}
    </span>
  </button>
);

export const Sheets = () => {
  const s = useBuy(
    useShallow((s: BuyState) => ({
      sheet: s.sheet,
      currency: s.currency,
      app: s.app,
      quotes: s.quotes,
      offerIdx: s.offerIdx,
    })),
  );
  const close = () => openSheet(null);
  const offers = s.quotes?.kind === 'offers' ? s.quotes.offers : [];
  return (
    <>
      <Sheet
        open={s.sheet === 'app'}
        onOpenChange={o => !o && close()}
        title='pay with'
        className='mx-auto max-w-[620px]'
      >
        <div className='flex flex-col border border-border-soft'>
          {PAY_APPS.map((a, i) => {
            const note = appNote(a, s.currency);
            return (
              <Pick
                key={a.id}
                first={i === 0}
                on={a.id === s.app}
                off={!!note}
                onClick={() => setApp(a.id)}
              >
                <span className='grid size-8 place-items-center border border-border-hard bg-elev-2 text-sm'>
                  {a.mark}
                </span>
                <span className='flex-1 text-sm text-fg-high'>{a.name}</span>
                <span className='text-xs text-fg-muted'>{note ?? a.via ?? ''}</span>
              </Pick>
            );
          })}
        </div>
        <Button onClick={close}>done</Button>
      </Sheet>

      <Sheet
        open={s.sheet === 'seller'}
        onOpenChange={o => !o && close()}
        title={`sellers on ${payApp(s.app)?.name ?? ''}`}
        className='mx-auto max-w-[620px]'
      >
        <div className='flex flex-col border border-border-soft'>
          {offers.map((o, i) => (
            <Pick
              key={o.depositId}
              first={i === 0}
              on={i === s.offerIdx}
              onClick={() => setOffer(i)}
            >
              <span className='flex flex-1 flex-col gap-0.5'>
                <span className='text-sm text-fg-high'>{o.handle}</span>
                <span className='text-[11px] text-fg-muted'>{usdc2(o.net)} usdc to you</span>
              </span>
              <span className='text-right text-xs text-fg-muted'>
                {rate3(o.rate)} {s.currency} per usdc
              </span>
            </Pick>
          ))}
          {!offers.length && (
            <span className='p-4 text-xs text-fg-muted'>no sellers yet for this amount</span>
          )}
        </div>
        <Button onClick={close}>use this seller</Button>
      </Sheet>

      <Sheet
        open={s.sheet === 'cur'}
        onOpenChange={o => !o && close()}
        title='your currency'
        className='mx-auto max-w-[620px]'
      >
        <div className='grid grid-cols-4 gap-2'>
          {CURRENCIES.map(c => (
            <button
              key={c}
              type='button'
              onClick={() => setCurrency(c)}
              className={cn(
                'h-11 border text-sm',
                c === s.currency ? 'border-zigner-gold bg-elev-2' : 'border-border-soft bg-elev-1',
              )}
            >
              {c}
            </button>
          ))}
        </div>
      </Sheet>

      <Sheet
        open={s.sheet === 'gone'}
        onOpenChange={o => !o && close()}
        title='that seller just filled up'
        className='mx-auto max-w-[620px]'
      >
        <p className='text-sm text-fg-muted'>
          someone reached them a moment before you. nothing was paid. the next seller is ready.
        </p>
        <div className='flex gap-2.5'>
          <Button variant='secondary' className='flex-1' onClick={() => openSheet('seller')}>
            choose another
          </Button>
          <Button
            className='flex-1'
            onClick={() => {
              close();
              requote();
            }}
          >
            continue
          </Button>
        </div>
      </Sheet>
    </>
  );
};
