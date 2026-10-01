import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useStore } from '../../../state';
import { contactsSelector, type ContactNetwork } from '../../../state/contacts';
import { useZcashMeDirectoryLookup } from '../../../services/zcashme/config';
import { zcashMeLabel } from '../../../services/zcashme/label';
import { SaveContactModal } from '../../../components/save-contact-modal';
import { useTxNote } from '../../../hooks/use-tx-note';
import { Sensitive } from '../../../components/sensitive';
import { cn } from '@repo/ui/lib/utils';
import { PopupPath } from '../paths';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { CopyButton } from '@repo/ui/components/ui/copy-button';
import type { NetworkType } from '../../../state/keyring';
import { fmtTime } from './format';
import type { ParsedTransaction } from './tx-parse';

/**
 * The unsettled-transaction mark: the same ensō the sync line uses, drawn as
 * an open arc that never closes. Deliberately the *same* idiom rather than a
 * new one - "not finished yet" already has a visual language in this wallet,
 * and a spinner would shout where this whispers.
 */
const PendingMark = ({ className }: { className?: string }) => (
  <svg width='16' height='16' viewBox='0 0 16 16' className={cn('-rotate-90 shrink-0', className)}>
    <circle
      cx='8'
      cy='8'
      r='6.4'
      pathLength='100'
      fill='none'
      strokeWidth='1.8'
      strokeLinecap='round'
      strokeDasharray='100'
      strokeDashoffset='45'
      className='stroke-fg-dim'
    />
  </svg>
);

/** public per-tx explorer URL, per network. Penumbra's contents are shielded,
 *  but the tx hash IS public and penumbra.fi/explore resolves it, so the link is
 *  offered (still behind the opt-in explorer-links gate, since it leaks IP). */
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

export function TxRow({ tx, network }: { tx: ParsedTransaction; network: NetworkType }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  // explorer links leak your IP + the looked-up txid to a third party, so they
  // are opt-in; copying the txid never leaves the wallet and is always offered.
  const explorerEnabled = useStore(s => s.privacy.settings.enableExplorerLinks);
  const explorer = explorerEnabled ? txExplorerUrl(network, tx.id) : undefined;
  // a deposit (IBC in) lands funds like a receive; unshield is a pool<->
  // transparent move, shown neutrally like a shield
  const isIn = tx.type === 'receive' || tx.type === 'deposit';
  const isSh = tx.type === 'shield' || tx.type === 'unshield';
  // DEX liquidity activity (open/close/withdraw/reward) is neither a directional
  // transfer nor a shield - it gets its own neutral swap-style glyph so it does
  // not read as a plain send.
  const isLp = tx.type === 'liquidity';
  const isPending = tx.status === 'pending';
  const isFailed = tx.status === 'failed';
  // a known recipient can be saved to contacts on click - the first brick of
  // the wallet-held social graph (zafu#28); memo gets its own line above it.
  const { findByAddress } = useStore(contactsSelector);
  const [showSave, setShowSave] = useState(false);
  const contactMatch = tx.recipient ? findByAddress(tx.recipient) : undefined;
  // no contact yet: fall back to the local zcash.me directory snapshot (a
  // pure map lookup - nothing leaves the wallet)
  const directoryLookup = useZcashMeDirectoryLookup();
  const directoryProfile = contactMatch ? undefined : directoryLookup(tx.recipient);
  const directoryName = zcashMeLabel(directoryProfile);
  // local "from" note for received txs - the chain never reveals the sender of
  // a shielded note, so the user labels it themselves. Stored in chrome.storage
  // (survives resync), keyed by txid.
  const { note: fromNote, save: saveFromNote } = useTxNote(tx.id);
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const contactNet: ContactNetwork =
    network === 'zcash' ? 'zcash' : network === 'penumbra' ? 'penumbra' : 'cosmos';
  const detail = tx.memo;
  // the amount/fee split is worth a line of its own: it is what explains why
  // the balance moved by more than the payment
  const hasBreakdown = !!tx.recipientAmount && !!tx.feeAmount;

  return (
    <>
      {/* summary row - tapping it opens the detail Sheet; nothing expands in
          place here. Its own controls (copy, save, edit note) live in the
          sheet, where a tap acts on that control rather than closing it. */}
      <button
        type='button'
        onClick={() => setOpen(true)}
        className={cn(
          'flex items-center gap-3 border bg-elev-1 p-3 text-left transition-colors',
          isFailed ? 'border-hanko/40' : 'border-border-soft',
          // pending rows recede rather than flash: they are not an alert, they
          // are simply not finished
          isPending && 'border-dashed',
        )}
      >
        {/* direction reads from the lucide icon, not from color-as-category:
            shield / arrow-down / arrow-up on a neutral chip. An unsettled
            transaction shows the open ensō instead - the state matters more
            than the direction until it lands. */}
        <div className='flex h-8 w-8 items-center justify-center bg-elev-2'>
          {isPending ? (
            <PendingMark />
          ) : isFailed ? (
            <span className='i-ph-x h-4 w-4 text-hanko' />
          ) : isSh ? (
            <span className='i-ph-shield h-4 w-4 text-fg-muted' />
          ) : isLp ? (
            <span className='i-ph-arrows-left-right h-4 w-4 text-fg-muted' />
          ) : isIn ? (
            <span className='i-ph-arrow-down h-4 w-4 text-fg-high' />
          ) : (
            <span className='i-ph-arrow-up h-4 w-4 text-fg-muted' />
          )}
        </div>
        <div className='flex-1 min-w-0'>
          <div className='flex items-center justify-between gap-2'>
            <span className={cn('text-xs', isPending && 'text-fg-muted', isFailed && 'text-hanko')}>
              {tx.description}
            </span>
            {tx.amount && (
              <Sensitive
                className={cn(
                  'text-xs font-mono',
                  isFailed && 'text-fg-dim line-through',
                  !isFailed && isIn && 'text-fg-high',
                  !isFailed && !isIn && 'text-fg-muted',
                )}
              >
                {/* "at most" rather than a confident figure: the change that
                    came back has not been scanned yet, so the true amount is
                    somewhere below this. Better vague than five times wrong. */}
                {tx.amountUpperBound ? '≤ ' : isIn ? '+' : ''}
                {tx.amount} {tx.asset ?? ''}
              </Sensitive>
            )}
          </div>
          <div className='flex items-center justify-between gap-2 mt-0.5'>
            <span className='text-label text-fg-muted font-mono truncate'>
              {tx.id.slice(0, 16)}...
            </span>
            {/* A row with no height has no block to name. Rather than print a
                confident-looking `#0`, say plainly what is and is not known:
                when we broadcast it, and that the chain has not answered. */}
            <span
              className={cn(
                'text-label whitespace-nowrap lowercase',
                isFailed ? 'text-hanko' : 'text-fg-muted',
              )}
            >
              {tx.height > 0
                ? `#${tx.height}`
                : isPending
                  ? `${fmtTime(tx.timestamp)} · unconfirmed`
                  : isFailed
                    ? 'expired'
                    : fmtTime(tx.timestamp)}
            </span>
          </div>
        </div>
      </button>

      <Sheet open={open} onOpenChange={setOpen} title={tx.description}>
        <div className='flex flex-col gap-3'>
          {detail && (
            <p className='text-xs text-fg-muted whitespace-pre-wrap break-words'>{detail}</p>
          )}
          {/* where the money went, itemised - the difference between this and
              the note values spent is change, which never left the wallet */}
          {hasBreakdown && (
            <p className='text-label text-fg-dim tabular'>
              <Sensitive>
                {tx.recipientAmount} {tx.asset ?? ''} sent · {tx.feeAmount} fee
              </Sensitive>
            </p>
          )}

          <RowGroup>
            {/* recipient: a known contact shows its petname; an unknown address
                is one click from being saved to contacts (social-graph brick). */}
            {tx.recipient &&
              (contactMatch ? (
                <Row
                  type='screen'
                  icon='i-ph-user'
                  label={`to ${contactMatch.contact.name}`}
                  onPress={() => {
                    setOpen(false);
                    navigate(`${PopupPath.CONTACTS}?open=${contactMatch.contact.id}`);
                  }}
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

            {/* received: a local "from" label the user adds themselves, since
                the chain never reveals the sender of a shielded note. */}
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

            {/* txid: always copyable (no leak); "open in explorer" only when
                the user has opted into explorer links (it reveals their ip). */}
            <div className='flex min-h-[52px] items-center gap-3 px-3.5 py-2'>
              <span className='flex min-w-0 flex-1 flex-col gap-0.5'>
                <span className='truncate text-data text-fg-high font-mono'>{tx.id}</span>
                <span className='text-label text-fg-muted lowercase'>txid</span>
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
          </RowGroup>
        </div>
      </Sheet>

      {showSave && tx.recipient && (
        <SaveContactModal
          address={tx.recipient}
          network={contactNet}
          zcashme={directoryProfile}
          onDone={() => setShowSave(false)}
          onCancel={() => setShowSave(false)}
        />
      )}
    </>
  );
}
