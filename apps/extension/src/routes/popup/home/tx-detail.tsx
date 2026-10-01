import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useStore } from '../../../state';
import { contactsSelector, type ContactNetwork } from '../../../state/contacts';
import { useZcashMeDirectoryLookup } from '../../../services/zcashme/config';
import { zcashMeLabel } from '../../../services/zcashme/label';
import { SaveContactModal } from '../../../components/save-contact-modal';
import { useTxNote } from '../../../hooks/use-tx-note';
import { Sensitive } from '../../../components/sensitive';
import { cn } from '@repo/ui/lib/utils';
import { PopupPath } from '../paths';
import { ScreenHeader } from '../../../components/screen-header';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Button } from '@repo/ui/components/ui/button';
import { CopyButton } from '@repo/ui/components/ui/copy-button';
import type { NetworkType } from '../../../state/keyring';
import { fmtTime, fmtZecHero } from './format';
import type { ParsedTransaction } from './tx-parse';

const txExplorerUrl = (network: NetworkType, txid: string): string | undefined => {
  switch (network) {
    case 'zcash':
      return `https://cipherscan.app/tx/${txid}`;
    case 'penumbra':
      return `https://penumbra.fi/explore/tx/${txid}`;
    case 'noble':
      return `https://www.mintscan.io/noble/tx/${txid}`;
    case 'injective':
      return `https://explorer.injective.network/transaction/${txid}`;
    default:
      return undefined;
  }
};

interface TxDetailState {
  tx: ParsedTransaction;
  network: NetworkType;
}

/**
 * One transaction, in full. Opened from an activity row or from a send's
 * "view transaction" - both hand it the already-fetched record via router
 * state, so this never issues its own request. Reopening the route cold
 * (no state, e.g. a stale deep link) shows a calm empty state instead of
 * guessing at a fetch.
 */
export const TxDetailPage = () => {
  const { state } = useLocation();
  const { tx, network } = (state as TxDetailState | null) ?? {};

  if (!tx) {
    return (
      <div className='flex min-h-full flex-col'>
        <ScreenHeader title='transaction' backPath={PopupPath.ACTIVITY} />
        <div className='flex flex-1 items-center justify-center px-6 text-center text-xs text-fg-muted'>
          this transaction isn&apos;t open anymore - go back to activity to find it again.
        </div>
      </div>
    );
  }
  return <TxDetailContent tx={tx} network={network ?? 'zcash'} />;
};

const TxDetailContent = ({ tx, network }: { tx: ParsedTransaction; network: NetworkType }) => {
  const navigate = useNavigate();
  const explorerEnabled = useStore(s => s.privacy.settings.enableExplorerLinks);
  const explorer = explorerEnabled ? txExplorerUrl(network, tx.id) : undefined;
  const isIn = tx.type === 'receive' || tx.type === 'deposit';
  const isSh = tx.type === 'shield' || tx.type === 'unshield';
  const isPending = tx.status === 'pending';
  const isFailed = tx.status === 'failed';
  const { findByAddress } = useStore(contactsSelector);
  const [showSave, setShowSave] = useState(false);
  const contactMatch = tx.recipient ? findByAddress(tx.recipient) : undefined;
  const directoryLookup = useZcashMeDirectoryLookup();
  const directoryProfile = contactMatch ? undefined : directoryLookup(tx.recipient);
  const directoryName = zcashMeLabel(directoryProfile);
  const { note: fromNote, save: saveFromNote } = useTxNote(tx.id);
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const contactNet: ContactNetwork =
    network === 'zcash' ? 'zcash' : network === 'penumbra' ? 'penumbra' : 'cosmos';
  const hasBreakdown = !!tx.recipientAmount && !!tx.feeAmount;
  const recipientName =
    contactMatch?.contact.name ??
    directoryName ??
    (tx.recipient && `${tx.recipient.slice(0, 8)}…${tx.recipient.slice(-4)}`);
  const title = isIn
    ? 'received'
    : isSh
      ? tx.description
      : recipientName
        ? `sent to ${recipientName}`
        : tx.description;
  const amountText =
    network === 'zcash'
      ? fmtZecHero(Number(tx.amount ?? 0))
      : `${tx.amount ?? ''} ${tx.asset ?? ''}`;

  // What we can honestly say about progress: a history record only ever
  // carries one status (pending/confirmed/failed), not a timestamped sub-step
  // log, so the checklist below is the coarsest truthful read of it - not the
  // per-step timeline the board sketches, since that data isn't stored.
  const steps: { label: string; done: boolean; failed?: boolean }[] = isFailed
    ? [
        { label: 'sent to the network', done: true },
        { label: 'did not confirm', done: true, failed: true },
      ]
    : isPending
      ? [
          { label: 'sent to the network', done: true },
          { label: 'waiting for a block', done: false },
        ]
      : [];

  return (
    <div className='flex min-h-full flex-col'>
      <ScreenHeader title={title} backPath={PopupPath.ACTIVITY} />
      <div className='flex flex-col gap-4 px-4 py-4'>
        {tx.amount && (
          <div className='text-center'>
            <Sensitive
              className={cn(
                'text-3xl tabular-nums',
                isFailed ? 'text-fg-dim line-through' : 'text-fg-high',
              )}
            >
              {tx.amountUpperBound ? '≤ ' : ''}
              {amountText}
            </Sensitive>
          </div>
        )}

        {steps.length > 0 && (
          <div className='flex flex-col gap-2'>
            {steps.map((s, i) => (
              <div key={i} className='flex items-center gap-2 text-sm'>
                <span
                  className={cn(
                    'size-3 shrink-0 border',
                    s.failed
                      ? 'border-hanko bg-hanko/30'
                      : s.done
                        ? 'border-zigner-gold bg-zigner-gold'
                        : 'border-fg-muted',
                  )}
                />
                <span className={s.failed ? 'text-hanko' : 'text-fg-high'}>{s.label}</span>
                <span className='ml-auto text-label text-fg-muted'>
                  {fmtTime(tx.sentAt ?? tx.timestamp)}
                </span>
              </div>
            ))}
          </div>
        )}

        {isFailed && (
          <div className='flex items-start gap-2 border border-success/40 bg-elev-1 p-3'>
            <span className='i-ph-check mt-0.5 size-3.5 shrink-0 text-success' />
            <p className='text-label text-fg-muted leading-snug'>
              {recipientName ? `${recipientName} never received this. ` : ''}nothing left your
              wallet - you can send it again whenever you like.
            </p>
          </div>
        )}

        {tx.memo && (
          <p className='text-xs text-fg-muted whitespace-pre-wrap break-words'>{tx.memo}</p>
        )}
        {hasBreakdown && (
          <p className='text-label text-fg-dim tabular'>
            <Sensitive>
              {tx.recipientAmount} {tx.asset ?? ''} sent · {tx.feeAmount} fee
            </Sensitive>
          </p>
        )}

        <RowGroup>
          {tx.recipient &&
            (contactMatch ? (
              <Row
                type='screen'
                icon='i-ph-user'
                label={`to ${contactMatch.contact.name}`}
                onPress={() => navigate(`${PopupPath.CONTACTS}?open=${contactMatch.contact.id}`)}
              />
            ) : (
              <div className='flex items-center'>
                <Row
                  type='screen'
                  icon='i-ph-arrow-up-right'
                  label={
                    directoryName ??
                    (tx.recipient.length > 20
                      ? `${tx.recipient.slice(0, 10)}…${tx.recipient.slice(-6)}`
                      : tx.recipient)
                  }
                  description={directoryName ? 'zcash.me' : 'to'}
                  className='flex-1 min-w-0'
                  onPress={() => setShowSave(true)}
                />
                <CopyButton text={tx.recipient} className='mr-3.5' />
              </div>
            ))}

          {isIn &&
            (editingNote ? (
              <div className='flex items-center gap-1 px-3.5 py-2'>
                <input
                  autoFocus
                  value={noteDraft}
                  onChange={e => setNoteDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      void saveFromNote(noteDraft);
                      setEditingNote(false);
                    }
                    if (e.key === 'Escape') {
                      setEditingNote(false);
                    }
                  }}
                  placeholder='who was this from?'
                  className='min-w-0 flex-1 border border-border-soft bg-transparent px-1.5 py-0.5 text-label'
                />
                <button
                  type='button'
                  onClick={() => {
                    void saveFromNote(noteDraft);
                    setEditingNote(false);
                  }}
                  className='text-label text-network-accent'
                >
                  save
                </button>
              </div>
            ) : (
              <Row
                type='screen'
                icon='i-ph-note-pencil'
                label={fromNote ? `from ${fromNote}` : 'note who this was from'}
                onPress={() => {
                  setNoteDraft(fromNote ?? '');
                  setEditingNote(true);
                }}
              />
            ))}

          <div className='flex min-h-[52px] items-center gap-3 px-3.5 py-2'>
            <span className='flex min-w-0 flex-1 flex-col gap-0.5'>
              <span className='truncate text-data text-fg-high font-mono'>{tx.id}</span>
              <span className='text-label text-fg-muted lowercase'>transaction</span>
            </span>
            <CopyButton text={tx.id} />
            {explorer && (
              <a
                href={explorer}
                target='_blank'
                rel='noopener noreferrer'
                className='mr-3.5 shrink-0 text-fg-muted transition-colors hover:text-fg-high'
                title='open in block explorer (reveals your ip)'
              >
                <span className='i-ph-arrow-square-out h-3.5 w-3.5' />
              </a>
            )}
          </div>
          <div className='flex items-center justify-between px-3.5 py-2 text-sm'>
            <span className='text-fg-muted'>fee</span>
            <span>{isFailed ? 'not charged' : (tx.feeAmount ?? '—')}</span>
          </div>
        </RowGroup>

        {isFailed && !isIn && (
          <Button
            onClick={() =>
              navigate(PopupPath.SEND, {
                state: { prefillRecipient: tx.recipient, prefillMemo: tx.memo },
              })
            }
          >
            send again
          </Button>
        )}
      </div>

      {showSave && tx.recipient && (
        <SaveContactModal
          address={tx.recipient}
          network={contactNet}
          zcashme={directoryProfile}
          onDone={() => setShowSave(false)}
          onCancel={() => setShowSave(false)}
        />
      )}
    </div>
  );
};
