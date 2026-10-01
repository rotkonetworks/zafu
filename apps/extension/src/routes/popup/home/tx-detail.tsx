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
import { isIncoming, type ParsedTransaction } from './tx-parse';
import { penumbraRefs } from '../../../history/penumbra-describe';

interface TxLook {
  explorer?: (txid: string) => string;
  /** the hero: figure and unit */
  hero: (tx: ParsedTransaction) => { amount: string; unit: string };
  /** a build step this network proves locally before sending */
  proved?: string;
  contact: ContactNetwork;
}

const asset = (tx: ParsedTransaction) => ({
  amount: tx.entry?.amounts[0]?.exact ?? tx.amount ?? '',
  unit: (tx.asset ?? '').toLowerCase(),
});

/** what one transaction looks like per network */
const LOOK: Partial<Record<NetworkType, TxLook>> = {
  zcash: {
    explorer: id => `https://cipherscan.app/tx/${id}`,
    hero: tx => ({ amount: fmtZecHero(Number(tx.amount ?? 0)), unit: 'zec' }),
    proved: 'proved on this computer',
    contact: 'zcash',
  },
  penumbra: {
    explorer: id => `https://penumbra.fi/explore/tx/${id}`,
    hero: asset,
    proved: 'proved on this computer',
    contact: 'penumbra',
  },
  noble: {
    explorer: id => `https://www.mintscan.io/noble/tx/${id}`,
    hero: asset,
    contact: 'cosmos',
  },
  injective: {
    explorer: id => `https://explorer.injective.network/transaction/${id}`,
    hero: asset,
    contact: 'cosmos',
  },
};
const PLAIN: TxLook = { hero: asset, contact: 'cosmos' };

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
  const look = LOOK[network] ?? PLAIN;
  const explorer = explorerEnabled ? look.explorer?.(tx.id) : undefined;
  const isIn = isIncoming(tx);
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
  // an expired send charged no fee, so it has no breakdown to give
  const hasBreakdown = !isFailed && !!tx.recipientAmount && !!tx.feeAmount;
  const shortRecipient = tx.recipient && `${tx.recipient.slice(0, 8)}…${tx.recipient.slice(-4)}`;
  const recipientName = contactMatch?.contact.name ?? directoryName ?? shortRecipient;
  const title = isIn
    ? 'received'
    : isSh
      ? tx.description
      : recipientName
        ? `sent to ${recipientName}`
        : tx.description;
  const hero = look.hero(tx);

  // What we can honestly say about progress: a history record carries one
  // status and the broadcast time, not a per-step log, so only the rows that
  // status proves are drawn (board StTxReturned). An expired send's inputs
  // stay marked spent until the chain is read again (sent-tx-reconcile.ts),
  // so "returned to your wallet" is not claimed.
  const sentAt = fmtTime(tx.sentAt ?? tx.timestamp);
  const steps: { label: string; mark: 'done' | 'warn' | 'wait'; at?: string }[] =
    isFailed || isPending
      ? [
          ...(look.proved ? [{ label: look.proved, mark: 'done' as const, at: sentAt }] : []),
          { label: 'sent to the network', mark: 'done', at: sentAt },
          isFailed
            ? { label: 'expired before a block found it', mark: 'warn' }
            : { label: 'waiting for a block', mark: 'wait' },
        ]
      : [];

  return (
    <div className='flex min-h-full flex-col'>
      <ScreenHeader title={title} backPath={PopupPath.ACTIVITY} />
      <div className='flex flex-1 flex-col gap-4 px-4 py-5'>
        {tx.amount && (
          <Sensitive className='font-display text-[38px] leading-none text-fg-high'>
            {tx.amountUpperBound ? '≤ ' : ''}
            {hero.amount}
            {hero.unit && <span className='ml-2.5 text-base text-network-accent'>{hero.unit}</span>}
          </Sensitive>
        )}

        {steps.length > 0 && (
          <ol className='flex flex-col divide-y divide-border-soft border border-border-soft bg-elev-1'>
            {steps.map(s => (
              <li
                key={s.label}
                className={cn(
                  'flex h-11 items-center gap-2.5 px-3.5 text-[13px]',
                  s.mark === 'warn' ? 'text-warn' : 'text-fg-high',
                )}
              >
                <span
                  className={cn(
                    'size-3 shrink-0',
                    s.mark === 'done' && 'bg-network-accent',
                    s.mark === 'warn' && 'bg-warn',
                    s.mark === 'wait' && 'border border-network-accent',
                  )}
                />
                {s.label}
                <span className='ml-auto text-[11px] text-fg-muted'>{s.at}</span>
              </li>
            ))}
          </ol>
        )}

        {isFailed && (
          <div className='flex min-h-[58px] items-center gap-2.5 border border-success/40 bg-success/5 px-3.5 py-2.5'>
            <span className='i-ph-check size-4 shrink-0 text-success' />
            <p className='text-xs leading-normal text-fg'>
              {recipientName ? `${recipientName} never received this. ` : ''}nothing left your
              wallet - its zec is held until the chain is read again.
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

        {isFailed ? (
          <div className='flex flex-col divide-y divide-border-soft border border-border-soft bg-elev-1'>
            {tx.recipient && (
              <div className='flex h-[46px] items-center justify-between gap-3 px-3.5'>
                <span className='text-xs text-fg-muted'>to</span>
                <span className='truncate text-[13px] text-fg-high'>
                  {recipientName && recipientName !== shortRecipient
                    ? `${recipientName} · ${shortRecipient}`
                    : shortRecipient}
                </span>
              </div>
            )}
            <div className='flex h-[46px] items-center justify-between px-3.5'>
              <span className='text-xs text-fg-muted'>fee</span>
              <span className='text-[13px] text-fg-high'>not charged</span>
            </div>
          </div>
        ) : (
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

            {penumbraRefs(tx.entry, tx.recipient).map(r => (
              <div key={r.raw} className='flex min-h-[52px] items-center gap-3 px-3.5 py-2'>
                <span className='flex min-w-0 flex-1 flex-col gap-0.5'>
                  <span className='truncate text-data text-fg-high' title={r.raw}>
                    {r.display}
                  </span>
                  <span className='text-label text-fg-muted lowercase'>{r.label}</span>
                </span>
                <CopyButton text={r.raw} className='mr-3.5' />
              </div>
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
              <span>{tx.feeAmount ?? '—'}</span>
            </div>
          </RowGroup>
        )}
      </div>

      {isFailed && !isIn && (
        <footer className='shrink-0 border-t border-border-soft px-4 pb-4 pt-3'>
          <Button
            className='w-full'
            onClick={() =>
              navigate(PopupPath.SEND, {
                state: { prefillRecipient: tx.recipient, prefillMemo: tx.memo },
              })
            }
          >
            send again
          </Button>
        </footer>
      )}

      {showSave && tx.recipient && (
        <SaveContactModal
          address={tx.recipient}
          network={look.contact}
          zcashme={directoryProfile}
          onDone={() => setShowSave(false)}
          onCancel={() => setShowSave(false)}
        />
      )}
    </div>
  );
};
