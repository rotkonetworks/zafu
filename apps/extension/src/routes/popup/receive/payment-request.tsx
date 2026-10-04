/**
 * ZIP 321 payment request - a sheet for attaching an amount (and, for a
 * shielded address, a memo) to a payment link before copying it. Nothing
 * expands in place on the receive screen: this used to be an inline panel
 * that pushed the layout down; it is a Sheet now.
 */

import { useState } from 'react';
import { useCopy } from '@repo/ui/hooks/use-copy';
import { buildZip321, parseZecAmount } from '@repo/wallet/networks/zcash/zip321';
import { RequestSheet } from '../send/send-fields';

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

  return (
    <RequestSheet
      open={open}
      onOpenChange={onOpenChange}
      title='request amount'
      amount={amount}
      onAmount={setAmount}
      amountWarn={amountInvalid}
      note={
        isShielded ? { value: memo, onChange: setMemo, label: 'memo', maxLength: 512 } : undefined
      }
      confirmLabel={copied ? 'copied' : 'copy payment link'}
      confirmDisabled={amountInvalid}
      onConfirm={() => {
        copy(link);
        onCopied(link);
      }}
    />
  );
}
