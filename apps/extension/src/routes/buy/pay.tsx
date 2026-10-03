/**
 * Buy 2 and 3: pay the seller exactly, then let zafu read that one payment
 * (or point at it when several match), and the calm states around them.
 */

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Button } from '@repo/ui/components/ui/button';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { cn } from '@repo/ui/lib/utils';
import { useShallow } from 'zustand/react/shallow';
import { payApp, ZELLE_BANKS, type TemplateKey } from '../../buy/apps';
import { loadOffer, clock, INTENT_LIFETIME_MS } from '../../buy/machine';
import { Column, useBuy, useNow } from './ui';
import { money } from '../../buy/fees';
import { KEEP_DAYS } from '../../buy/capture/kept';
import {
  allowRead,
  cancelBuy,
  chooseRow,
  closeOverlay,
  finish,
  lookAgain,
  paid,
  reserveNow,
  setBank,
  setKeep,
  type BuyState,
} from './store';

/** where an app takes a payment to a handle, when it has a public link */
const payLink = (app: string, handle: string): string | undefined =>
  app === 'revolut' ? `https://revolut.me/${encodeURIComponent(handle)}` : undefined;

const Lock = ({ tone }: { tone: string }) => (
  <span className={cn('i-lucide-lock size-3.5', tone)} aria-hidden='true' />
);

const CopyRow = ({
  k,
  v,
  hint,
  first,
}: {
  k: string;
  v: string;
  hint: string;
  first?: boolean;
}) => {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className={cn(
        'flex h-16 items-center gap-3.5 pl-[18px] pr-2.5',
        !first && 'border-t border-border-soft',
      )}
    >
      <span className='w-16 shrink-0 text-xs text-fg-muted'>{k}</span>
      <span
        className={cn(
          'min-w-0 flex-1 break-all text-fg-high',
          v.length > 24 ? 'text-sm' : 'text-lg',
        )}
      >
        {v}
      </span>
      <span className='text-[11px] text-fg-muted'>{hint}</span>
      <Button
        variant='secondary'
        aria-label={`copy ${k}`}
        className={cn('h-9 w-[76px] text-xs', copied ? 'text-green' : 'text-zigner-gold')}
        onClick={() => void navigator.clipboard.writeText(v).then(() => setCopied(true))}
      >
        {copied ? 'copied' : 'copy'}
      </Button>
    </div>
  );
};

const QR = ({ text }: { text: string }) => {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    void QRCode.toDataURL(text, {
      margin: 1,
      width: 132,
      color: { dark: '#141008', light: '#f2ecdf' },
    }).then(setSrc);
  }, [text]);
  return src ? (
    <img src={src} alt='code to pay from your phone' className='size-[132px]' />
  ) : (
    <span className='size-[132px]' />
  );
};

export const PayScreen = () => {
  const { buy, resumed, error } = useBuy(
    useShallow((s: BuyState) => ({ buy: s.buy, resumed: s.resumed, error: s.error })),
  );
  const now = useNow();
  if (!buy) {
    return null;
  }
  const o = loadOffer(buy.offer);
  const app = payApp(buy.app);
  const left = buy.expiresAt ? buy.expiresAt - now : INTENT_LIFETIME_MS;
  const expired = buy.stage === 'expired';
  const link = payLink(buy.app, o.handle);
  const strip = expired
    ? {
        text: "the seller's usdc went back to them",
        tone: 'text-fg-muted',
        box: 'border-border-soft bg-elev-1',
      }
    : resumed
      ? {
          text: 'welcome back · this buy kept its place',
          tone: 'text-zigner-gold',
          box: 'border-gold-line bg-elev-1',
        }
      : {
          text: `${o.handle}'s ${(Number(o.gross) / 1e6).toFixed(2)} usdc is held for you`,
          tone: 'text-green',
          box: 'border-border-soft bg-elev-1',
        };

  return (
    <div className='flex flex-col gap-[18px]'>
      <div className={cn('flex h-10 items-center gap-2.5 border px-3.5', strip.box)}>
        <Lock tone={strip.tone} />
        <span className='flex-1 text-xs'>{strip.text}</span>
      </div>
      <div className='flex items-end justify-between gap-4'>
        <h1 className='font-display text-[38px] leading-[1.15] text-fg-high'>
          pay {o.handle}
          <br />
          on {app?.name}
        </h1>
        <div className='flex flex-col items-end gap-1.5'>
          <span className='font-display text-[34px] tabular-nums text-fg-high'>{clock(left)}</span>
          <span className='text-[11px] text-fg-muted'>left to pay · the seller waits 6 hours</span>
        </div>
      </div>
      <div className='relative h-0.5 bg-border-soft'>
        <span
          className='absolute inset-y-0 left-0 bg-zigner-gold'
          style={{ width: `${Math.max(0, (left / INTENT_LIFETIME_MS) * 100)}%` }}
        />
      </div>

      <div className='flex flex-col border border-border-soft bg-elev-1'>
        <CopyRow first k='to' v={o.handle} hint={app?.name ?? ''} />
        <CopyRow k='amount' v={money(o.fiat, buy.currency)} hint='exactly' />
      </div>

      {app && (
        <div className='flex items-center gap-5'>
          {link && <QR text={link} />}
          <div className='flex flex-col gap-2.5'>
            {link && <span className='text-[13px] text-fg-muted'>scan to pay from your phone</span>}
            {app.id !== 'zelle' && (
              <a
                href={link ?? `https://${app.site}`}
                target='_blank'
                rel='noopener noreferrer'
                className='flex h-9 w-fit items-center gap-2 border border-border-hard bg-elev-2 px-3 text-xs text-fg-high'
              >
                {link ? 'or open' : 'open'} {app.site}
                <span className='i-lucide-arrow-up-right size-3' aria-hidden='true' />
              </a>
            )}
          </div>
        </div>
      )}

      {error && <span className='text-xs text-warn'>{error}</span>}
      <Button className='h-14' disabled={expired} onClick={() => void paid()}>
        {buy.stage === 'confirming' ? 'look for my payment again' : "i've paid"}
      </Button>
      {buy.stage === 'pay' && (
        <button
          type='button'
          onClick={() => void cancelBuy()}
          className='self-center text-xs text-fg-muted hover:text-fg-high'
        >
          cancel this buy
        </button>
      )}

      <Sheet
        open={expired}
        onOpenChange={() => undefined}
        title='the 6 hours to pay have passed'
        className='mx-auto max-w-[620px]'
      >
        <p className='text-sm text-fg-muted'>
          the seller's usdc went back to them on its own. nothing was taken from you. if you already
          sent the money, please let us know and we will help.
        </p>
        <div className='flex gap-2.5'>
          <Button variant='secondary' className='flex-1' onClick={() => lookAgain()}>
            i did pay
          </Button>
          <Button className='flex-1' onClick={() => void finish()}>
            start again
          </Button>
        </div>
      </Sheet>
    </div>
  );
};

/** Buy 3: may zafu look at the app, once, for this payment */
export const AskScreen = () => {
  const { buy, bank, keep } = useBuy(
    useShallow((s: BuyState) => ({ buy: s.buy, bank: s.bank, keep: s.keep })),
  );
  if (!buy) {
    return null;
  }
  const o = loadOffer(buy.offer);
  const app = payApp(buy.app);
  const banks = app?.id === 'zelle' ? (app.templates as TemplateKey[]) : [];
  const chosen = bank ?? banks[0];
  const where = app?.id === 'zelle' ? (chosen ? ZELLE_BANKS[chosen] : 'your bank') : app?.site;
  const rows = [
    ['zafu reads', `your ${app?.name} session, once, for this payment`, 'text-fg-high'],
    ['sealed to', "peer's verifier, which sees this payment record", 'text-fg'],
    ['never', 'saved, or used for anything else', 'text-fg'],
  ];
  return (
    <Column
      title={
        <>
          may zafu look at
          <br />
          {where} once?
        </>
      }
      sub={`to find your ${money(o.fiat, buy.currency)} to ${o.handle} and show it to the seller.`}
    >
      {banks.length > 0 && (
        <div className='flex gap-2'>
          {banks.map(b => (
            <button
              key={b}
              type='button'
              onClick={() => setBank(b)}
              className={cn(
                'h-9 border px-3 text-xs',
                b === chosen
                  ? 'border-zigner-gold bg-elev-2 text-fg-high'
                  : 'border-border-soft bg-elev-1',
              )}
            >
              {ZELLE_BANKS[b]}
            </button>
          ))}
        </div>
      )}
      <div className='flex flex-col border border-border-soft bg-elev-1'>
        {rows.map(([k, v, c], i) => (
          <div
            key={k}
            className={cn(
              'flex min-h-14 items-center gap-3.5 px-[18px] py-3',
              i && 'border-t border-border-soft',
            )}
          >
            <span className='w-20 shrink-0 text-xs text-fg-muted'>{k}</span>
            <span className={cn('text-sm', c)}>{v}</span>
          </div>
        ))}
      </div>
      <div className='flex items-center gap-2.5 text-xs text-fg-muted'>
        <Lock tone='text-fg-muted' />
        please be signed in to {where} on this computer
      </div>
      <label className='flex items-center gap-2 text-xs text-fg-muted'>
        <input
          type='checkbox'
          checked={keep}
          onChange={e => setKeep(e.target.checked)}
          className='accent-zigner-gold'
        />
        keep this for {KEEP_DAYS} days
      </label>
      <div className='flex gap-2.5'>
        <Button variant='secondary' className='h-14 w-[140px]' onClick={closeOverlay}>
          not now
        </Button>
        <Button className='h-14 flex-1' onClick={() => void allowRead()}>
          allow for this buy
        </Button>
      </div>
      <span className='text-xs text-fg-dim'>
        zafu gives the access back when this payment is read
      </span>
    </Column>
  );
};

/** several payments look like this one: the person points at theirs */
export const ChooseScreen = () => {
  const { rows, buy } = useBuy(useShallow((s: BuyState) => ({ rows: s.rows, buy: s.buy })));
  return (
    <Column title='which one is it?' sub='more than one payment looks like this one.'>
      <div className='flex flex-col border border-border-soft'>
        {rows.map((r, i) => (
          <button
            key={r.originalIndex}
            type='button'
            onClick={() => void chooseRow(r)}
            className={cn(
              'flex h-14 items-center gap-3.5 bg-elev-1 px-[18px] text-left hover:bg-elev-2',
              i && 'border-t border-border-soft',
            )}
          >
            <span className='flex-1 text-sm text-fg-high'>
              {String(r.recipientName ?? r.recipient ?? '')}
            </span>
            <span className='text-xs text-fg-muted'>{String(r.date ?? '')}</span>
            <span className='text-sm'>
              {String(r.amount ?? '')} {buy?.currency}
            </span>
          </button>
        ))}
      </div>
    </Column>
  );
};

export const FailedScreen = () => {
  const { buy, error } = useBuy(useShallow((s: BuyState) => ({ buy: s.buy, error: s.error })));
  const now = useNow();
  if (!buy) {
    return null;
  }
  const o = loadOffer(buy.offer);
  const app = payApp(buy.app);
  const checks = [
    `if ${app?.name} still shows it as pending, please look again once it completes`,
    `it needs to be exactly ${money(o.fiat, buy.currency)}, to ${o.handle}`,
    `from the ${app?.name} account signed in on this computer`,
  ];
  return (
    <Column
      title={
        <>
          we could not find
          <br />
          the payment yet
        </>
      }
      sub="the seller's usdc is still held for you. nothing is lost."
    >
      <div className='flex flex-col border border-border-soft bg-elev-1'>
        {checks.map((t, i) => (
          <div
            key={t}
            className={cn(
              'flex min-h-12 items-center gap-3 px-[18px] py-2 text-[13px]',
              i && 'border-t border-border-soft',
            )}
          >
            <span className='size-1.5 shrink-0 bg-fg-muted' />
            {t}
          </div>
        ))}
      </div>
      {buy.expiresAt && (
        <div className='flex items-center justify-between text-xs text-fg-muted'>
          held for you
          <span className='font-display text-xl tabular-nums text-fg-high'>
            {clock(buy.expiresAt - now)}
          </span>
        </div>
      )}
      {error && <span className='text-[11px] text-fg-dim'>{error}</span>}
      <div className='flex gap-2.5'>
        <Button variant='secondary' className='h-14 w-[140px]' asChild>
          <a
            href='https://docs.peer.xyz/guides/for-buyers/handling-verification-issues'
            target='_blank'
            rel='noopener noreferrer'
          >
            get help
          </a>
        </Button>
        <Button className='h-14 flex-1' onClick={lookAgain}>
          look again
        </Button>
      </div>
    </Column>
  );
};

/** no sponsor today: the person's own base address, for a little eth */
export const GasScreen = () => {
  const base = useBuy(s => s.base);
  return (
    <Column title='needs a little eth on base' sub='for the network fee. a few cents is plenty.'>
      <div className='flex flex-col border border-border-soft bg-elev-1'>
        <CopyRow first k='to' v={base ?? ''} hint='base' />
      </div>
      <div className='flex gap-2.5'>
        <Button variant='secondary' className='h-14 w-[140px]' onClick={closeOverlay}>
          not now
        </Button>
        <Button className='h-14 flex-1' onClick={() => void reserveNow()}>
          check again
        </Button>
      </div>
    </Column>
  );
};
