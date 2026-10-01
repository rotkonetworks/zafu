/**
 * ZIP 321 payment request - a sheet for attaching an amount (and, for a
 * shielded address, a memo) to a payment link before copying it. Nothing
 * expands in place on the receive screen: this used to be an inline panel
 * that pushed the layout down; it is a Sheet now.
 */

import { useState } from 'react';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
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
          <div className='relative'>
            <Input
              id='request-amount'
              type='text'
              inputMode='decimal'
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder='0.00'
              variant={amountInvalid ? 'error' : 'default'}
              className='h-14 pr-14 font-display text-2xl'
            />
            <span className='pointer-events-none absolute right-3.5 top-0 flex h-14 items-center text-label text-fg-muted'>
              zec
            </span>
          </div>
        </div>
        {isShielded && (
          <div className='flex flex-col gap-1.5'>
            <label htmlFor='request-memo' className='text-label text-fg-muted lowercase'>
              memo
            </label>
            <Input
              id='request-memo'
              type='text'
              value={memo}
              onChange={e => setMemo(e.target.value)}
              maxLength={512}
              placeholder='optional'
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
