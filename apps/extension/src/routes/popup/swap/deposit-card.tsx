import { CopyButton } from '@repo/ui/components/ui/copy-button';
import { QrCode } from '../../../components/qr-code';
import { Sensitive } from '../../../components/sensitive';
import type { Quote } from '../../../state/swap/provider';

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** a deposit deadline can be days out: tick under an hour, round above it */
export const untilLabel = (s: number) =>
  s < 3600
    ? mmss(s)
    : s < 48 * 3600
      ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
      : `${Math.floor(s / 86400)} days`;

/**
 * Where to pay into zec: the memo, and the vault as a qr and as text. Once the
 * window closes none of it is shown to scan or copy, since a late payment may
 * reach a vault that has moved on. The screen's own countdown re-renders it.
 */
export const DepositCard = ({
  deal,
  unit,
  chain,
  memoHow,
  refunds,
  now = Date.now(),
}: {
  deal: Pick<Quote, 'memo' | 'amountInText' | 'depositAddress' | 'expiresAt' | 'gasLine'>;
  unit: string;
  chain?: string;
  memoHow?: string;
  /** the line for a route that refunds whoever pays */
  refunds?: string;
  now?: number;
}) => {
  const left = deal.expiresAt ? Math.max(0, Math.ceil((deal.expiresAt - now) / 1000)) : undefined;
  if (left === 0) {
    return (
      <p className='border border-border-soft bg-elev-1 p-3 text-center text-xs text-fg-muted'>
        the deposit window has closed · please don&apos;t send to it now
      </p>
    );
  }
  return (
    <>
      {deal.memo && (
        <div className='flex flex-col gap-2 border border-zigner-gold bg-zigner-gold/10 p-3'>
          <span className='flex items-center justify-between'>
            <span className='text-xs text-fg-high'>memo · please include it</span>
            <CopyButton text={deal.memo} label='copy memo' />
          </span>
          <span className='break-all font-mono text-sm text-fg-high'>{deal.memo}</span>
          {memoHow && <span className='text-[11px] text-fg-muted'>{memoHow}</span>}
        </div>
      )}
      <div className='flex flex-col items-center gap-3 border border-border-soft bg-elev-1 p-3'>
        <p className='text-xs text-fg-muted'>
          send exactly <Sensitive>{`${deal.amountInText} ${unit}`}</Sensitive> on {chain} to
        </p>
        <QrCode value={deal.depositAddress} size={160} label='deposit address' />
        {left && <p className='text-xs text-zigner-gold'>{`pay within ${untilLabel(left)}`}</p>}
        {deal.gasLine && <p className='text-xs text-fg-muted'>{deal.gasLine}</p>}
        {refunds && <p className='text-xs text-warn'>{refunds}</p>}
        <div className='flex w-full items-center gap-2'>
          <span className='min-w-0 flex-1 break-all font-mono text-xs'>{deal.depositAddress}</span>
          <CopyButton text={deal.depositAddress} label='copy' />
        </div>
      </div>
    </>
  );
};
