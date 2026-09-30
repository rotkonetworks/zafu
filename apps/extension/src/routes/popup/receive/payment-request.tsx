/**
 * ZIP 321 payment request - a sheet for attaching an amount (and, for a
 * shielded address, a memo) to a payment link before copying it. Nothing
 * expands in place on the receive screen: this used to be an inline panel
 * that pushed the layout down; it is a Sheet now.
 */

import { useState } from 'react';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { Button } from '@repo/ui/components/ui/button';
import { useCopy } from '@repo/ui/hooks/use-copy';
import { buildZip321, parseZecAmount } from '@repo/wallet/networks/zcash/zip321';

export function PaymentRequestSheet({
  open,
  onOpenChange,
  address,
  isShielded,
  onCopied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  address: string;
  isShielded: boolean;
  /** called with the request URI actually copied, so the caller can retire a shielded address and reflect the link in its own QR */
  onCopied: (uri: string) => void;
}) {
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const { copied, copy } = useCopy();

  const zat = parseZecAmount(amount.trim());
  const amountInvalid = amount.trim() !== '' && zat === undefined;
  const memoText = isShielded ? memo.trim() : '';
  const link = buildZip321({ address, amountZat: zat, memo: memoText || undefined });

  const confirm = () => {
    copy(link);
    onCopied(link);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title='request amount'>
      <div className='flex flex-col gap-3'>
        <div className='flex flex-col gap-1.5'>
          <label htmlFor='request-amount' className='text-label text-fg-muted lowercase'>
            amount
          </label>
          <input
            id='request-amount'
            type='text'
            inputMode='decimal'
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder='0.00'
            className='h-11 border border-surface-border bg-surface-elev-2 px-3 text-sm text-fg-high focus:border-zigner-gold focus:outline-none'
          />
          <span className='h-4 text-label text-hanko-light lowercase'>
            {amountInvalid ? 'up to 8 decimals' : ''}
          </span>
        </div>
        {isShielded && (
          <div className='flex flex-col gap-1.5'>
            <label htmlFor='request-memo' className='text-label text-fg-muted lowercase'>
              memo
            </label>
            <input
              id='request-memo'
              type='text'
              value={memo}
              onChange={e => setMemo(e.target.value)}
              maxLength={512}
              placeholder='optional'
              className='h-11 border border-surface-border bg-surface-elev-2 px-3 text-sm text-fg-high focus:border-zigner-gold focus:outline-none'
            />
          </div>
        )}
        <Button onClick={confirm} disabled={amountInvalid}>
          {copied ? 'copied' : 'copy payment link'}
        </Button>
      </div>
    </Sheet>
  );
}
