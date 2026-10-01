import { useNavigate } from 'react-router-dom';

import { useStore } from '../../../state';
import { contactsSelector } from '../../../state/contacts';
import { useZcashMeDirectoryLookup } from '../../../services/zcashme/config';
import { zcashMeLabel } from '../../../services/zcashme/label';
import { useTxNote } from '../../../hooks/use-tx-note';
import { Sensitive } from '../../../components/sensitive';
import { cn } from '@repo/ui/lib/utils';
import { PopupPath } from '../paths';
import type { NetworkType } from '../../../state/keyring';
import { fmtTime, fmtZecHero } from './format';
import type { ParsedTransaction } from './tx-parse';

/** summary row - tapping it opens the TxDetail screen with the already-
 *  fetched record, never a refetch. The sheet this used to open now lives
 *  there, shared with the send-done screen's "view transaction". */
export function TxRow({ tx, network }: { tx: ParsedTransaction; network: NetworkType }) {
  const navigate = useNavigate();
  const isIn = tx.type === 'receive' || tx.type === 'deposit';
  const isSh = tx.type === 'shield' || tx.type === 'unshield';
  const isLp = tx.type === 'liquidity';
  const isPending = tx.status === 'pending';
  const isFailed = tx.status === 'failed';
  const { findByAddress } = useStore(contactsSelector);
  const contactMatch = tx.recipient ? findByAddress(tx.recipient) : undefined;
  const directoryLookup = useZcashMeDirectoryLookup();
  const directoryProfile = contactMatch ? undefined : directoryLookup(tx.recipient);
  const directoryName = zcashMeLabel(directoryProfile);
  const { note: fromNote } = useTxNote(tx.id);
  const recipientName =
    contactMatch?.contact.name ??
    directoryName ??
    (tx.recipient && `${tx.recipient.slice(0, 8)}…${tx.recipient.slice(-4)}`);
  const counterparty = isIn
    ? fromNote && `from ${fromNote}`
    : recipientName && `to ${recipientName}`;
  const amountText =
    network === 'zcash' ? fmtZecHero(Number(tx.amount)) : `${tx.amount} ${tx.asset ?? ''}`;

  return (
    <button
      type='button'
      onClick={() => navigate(PopupPath.TX_DETAIL, { state: { tx, network } })}
      className='flex h-[54px] items-center gap-3 px-1 text-left transition-colors hover:bg-elev-1'
    >
      <span className='grid size-[30px] shrink-0 place-items-center border border-border-soft bg-elev-1'>
        <span
          className={cn(
            'size-3.5',
            isPending
              ? 'i-zafu-enso text-zigner-gold'
              : isFailed
                ? 'i-lucide-x text-hanko'
                : isSh
                  ? 'i-lucide-shield text-fg-muted'
                  : isLp
                    ? 'i-lucide-arrow-left-right text-fg-muted'
                    : isIn
                      ? 'i-lucide-arrow-down-left text-success'
                      : 'i-lucide-arrow-up-right text-fg-muted',
          )}
        />
      </span>
      <span className='flex min-w-0 flex-1 flex-col gap-[3px]'>
        <span className={cn('text-[13px] text-fg-high', isFailed && 'text-hanko')}>
          {tx.description}
        </span>
        <span className='truncate text-[11px] text-fg-muted'>
          {[
            counterparty,
            tx.height > 0 || !isPending
              ? isFailed
                ? 'not mined in time'
                : fmtTime(tx.timestamp)
              : 'waiting for a block',
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
      {tx.amount && (
        <Sensitive
          className={cn(
            'shrink-0 text-[13px] tabular',
            isFailed ? 'text-fg-dim line-through' : isIn ? 'text-success' : 'text-fg',
          )}
        >
          {/* "at most": the change that came back has not been scanned yet */}
          {tx.amountUpperBound ? '≤ ' : isIn ? '+' : isSh ? '' : '−'}
          {amountText}
        </Sensitive>
      )}
    </button>
  );
}
