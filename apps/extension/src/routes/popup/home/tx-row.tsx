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
import type { NetworkType } from '../../../state/keyring';
import { fmtTime } from './format';
import type { ParsedTransaction } from './tx-parse';

/**
 * The unsettled-transaction mark: the same ensō the sync line uses, drawn as
 * an open arc that never closes. Deliberately the *same* idiom rather than a
 * new one — "not finished yet" already has a visual language in this wallet,
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
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [addrCopied, setAddrCopied] = useState(false);
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
  // the amount/fee split is worth opening a row for on its own: it is what
  // explains why the balance moved by more than the payment
  const hasBreakdown = !!tx.recipientAmount && !!tx.feeAmount;
  // always expandable now: even a bare tx has a txid worth copying / opening
  const expandable = true;

  return (
    <div
      className={cn(
        'rounded-lg border bg-elev-1 p-3 transition-colors',
        isFailed ? 'border-hanko/40' : 'border-border-soft',
        // pending rows recede rather than flash: they are not an alert, they
        // are simply not finished
        isPending && 'border-dashed',
      )}
    >
      {/* ONLY the header toggles expand/collapse. The details below carry their
          own controls (copy the txid, open the contact, edit a note) — a click
          there must act on that control, never fold the row shut. */}
      <div
        className={cn('flex items-center gap-3', expandable && 'cursor-pointer')}
        onClick={expandable ? () => setExpanded(e => !e) : undefined}
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        onKeyDown={
          expandable
            ? e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setExpanded(x => !x);
                }
              }
            : undefined
        }
      >
        {/* direction reads from the lucide icon, not from color-as-category:
            shield / arrow-down / arrow-up on a neutral chip. An unsettled
            transaction shows the open ensō instead — the state matters more
            than the direction until it lands. */}
        <div className='flex h-8 w-8 items-center justify-center rounded-full bg-elev-2'>
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
            <span
              className={cn(
                'text-xs font-medium',
                isPending && 'text-fg-muted',
                isFailed && 'text-hanko',
              )}
            >
              {tx.description}
            </span>
            <div className='flex items-center gap-1'>
              {tx.amount && (
                <Sensitive
                  className={cn(
                    'text-xs font-mono',
                    isFailed && 'text-fg-dim line-through',
                    !isFailed && isIn && 'text-fg-high',
                    !isFailed && !isIn && 'text-fg-muted',
                  )}
                >
                  {/* the payment/fee split lives in the expanded row, not a
                      tooltip — a title attribute would show the amount even
                      with balances hidden */}
                  {/* "at most" rather than a confident figure: the change that
                      came back has not been scanned yet, so the true amount is
                      somewhere below this. Better vague than five times wrong. */}
                  {tx.amountUpperBound ? '≤ ' : isIn ? '+' : ''}
                  {tx.amount} {tx.asset ?? ''}
                </Sensitive>
              )}
              {expandable && (
                <span
                  className={cn(
                    'i-ph-caret-down h-3 w-3 text-fg-muted transition-transform',
                    expanded && 'rotate-180',
                  )}
                />
              )}
            </div>
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
      </div>
      {expanded && (
        <div className='mt-2 ml-11 flex flex-col gap-1 border-l-2 border-border-soft pl-3'>
          {detail && (
            <p className='text-xs text-fg-muted whitespace-pre-wrap break-words'>{detail}</p>
          )}
          {/* recipient: a known contact shows its petname; an unknown address
              is one click from being saved to contacts (social-graph brick). */}
          {tx.recipient &&
            (contactMatch ? (
              // a known contact is one tap from its page — edit the name, add
              // addresses, or link a website/ZID. The petname, not the address.
              <button
                type='button'
                onClick={e => {
                  e.stopPropagation();
                  navigate(`${PopupPath.CONTACTS}?open=${contactMatch.contact.id}`);
                }}
                className='flex items-center gap-1 text-left text-label text-fg-dim transition-colors hover:text-fg-high'
                title='open contact'
              >
                <span className='i-ph-user h-3 w-3 shrink-0' /> to {contactMatch.contact.name}
                <span className='i-ph-caret-right h-3 w-3 shrink-0 text-fg-dim' />
              </button>
            ) : (
              // no contact yet: same idiom as the txid line below - the address
              // text copies the FULL string on click (the truncated form can't
              // be selected), and the trailing icon is the one action, save to
              // contacts. A zcash.me match shows the resolved name in place of
              // the raw address; the copy still lifts the address.
              <div className='flex items-center gap-1.5'>
                <span className='shrink-0 text-label text-fg-dim'>to</span>
                <button
                  type='button'
                  onClick={e => {
                    e.stopPropagation();
                    if (!tx.recipient) {
                      return;
                    }
                    void navigator.clipboard.writeText(tx.recipient);
                    setAddrCopied(true);
                    setTimeout(() => setAddrCopied(false), 1500);
                  }}
                  title={addrCopied ? 'copied' : 'click to copy address'}
                  className='group flex min-w-0 flex-1 items-center gap-1 text-left'
                >
                  <span className='min-w-0 flex-1 truncate font-mono text-label text-fg-muted transition-colors group-hover:text-fg-high'>
                    {directoryName ??
                      (tx.recipient.length > 20
                        ? `${tx.recipient.slice(0, 10)}…${tx.recipient.slice(-6)}`
                        : tx.recipient)}
                  </span>
                  {directoryName && (
                    <span className='shrink-0 text-label text-fg-dim'>zcash.me</span>
                  )}
                  <span
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 transition-colors',
                      addrCopied
                        ? 'i-ph-check text-network-accent'
                        : 'i-ph-copy text-fg-muted group-hover:text-fg-high',
                    )}
                  />
                </button>
                <button
                  type='button'
                  onClick={e => {
                    e.stopPropagation();
                    setShowSave(true);
                  }}
                  className='shrink-0 text-fg-muted transition-colors hover:text-network-accent'
                  title='save to contacts'
                >
                  <span className='i-ph-user-plus h-3.5 w-3.5' />
                </button>
              </div>
            ))}
          {showSave && tx.recipient && (
            <div onClick={e => e.stopPropagation()}>
              <SaveContactModal
                address={tx.recipient}
                network={contactNet}
                zcashme={directoryProfile}
                onDone={() => setShowSave(false)}
                onCancel={() => setShowSave(false)}
              />
            </div>
          )}
          {/* received: a local "from" label the user adds themselves, since the
              chain never reveals the sender of a shielded note. */}
          {isIn &&
            (editingNote ? (
              <div className='flex items-center gap-1' onClick={e => e.stopPropagation()}>
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
                  className='min-w-0 flex-1 rounded border border-border-soft bg-transparent px-1.5 py-0.5 text-label'
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
            ) : fromNote ? (
              <button
                type='button'
                onClick={e => {
                  e.stopPropagation();
                  setNoteDraft(fromNote);
                  setEditingNote(true);
                }}
                className='flex items-center gap-1 text-left text-label text-fg-dim transition-colors hover:text-fg-high'
                title='edit note'
              >
                <span className='i-ph-note-pencil h-3 w-3 shrink-0' /> from {fromNote}
              </button>
            ) : (
              <button
                type='button'
                onClick={e => {
                  e.stopPropagation();
                  setNoteDraft('');
                  setEditingNote(true);
                }}
                className='flex items-center gap-1 text-left text-label text-network-accent transition-colors hover:text-fg-high'
                title='note who this was from'
              >
                <span className='i-ph-note-pencil h-3 w-3 shrink-0' /> note who from
              </button>
            ))}
          {/* where the money went, itemised - the difference between this and
              the note values spent is change, which never left the wallet */}
          {hasBreakdown && (
            <p className='text-label text-fg-dim tabular'>
              <Sensitive>
                {tx.recipientAmount} {tx.asset ?? ''} sent · {tx.feeAmount} fee
              </Sensitive>
            </p>
          )}
          {/* txid: always copyable (no leak); "open in explorer" only when the
              user has opted into explorer links (it reveals their IP). */}
          <div className='flex items-center gap-1.5 pt-0.5'>
            <span className='shrink-0 text-label text-fg-dim'>txid</span>
            {/* the txid text itself copies on click — no hunting for a tiny icon */}
            <button
              type='button'
              onClick={e => {
                e.stopPropagation();
                void navigator.clipboard.writeText(tx.id);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              title={copied ? 'copied' : 'click to copy txid'}
              className='group flex min-w-0 flex-1 items-center gap-1 text-left'
            >
              <span className='min-w-0 flex-1 truncate font-mono text-label text-fg-muted transition-colors group-hover:text-fg-high'>
                {tx.id}
              </span>
              <span
                className={cn(
                  'h-3.5 w-3.5 shrink-0 transition-colors',
                  copied
                    ? 'i-ph-check text-network-accent'
                    : 'i-ph-copy text-fg-muted group-hover:text-fg-high',
                )}
              />
            </button>
            {explorer && (
              <a
                href={explorer}
                target='_blank'
                rel='noopener noreferrer'
                onClick={e => e.stopPropagation()}
                className='shrink-0 text-fg-muted transition-colors hover:text-fg-high'
                title='open in block explorer (reveals your ip)'
              >
                <span className='i-ph-arrow-square-out h-3.5 w-3.5' />
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

