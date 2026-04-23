/**
 * inbox - conversation-oriented encrypted messaging
 *
 * conversations are grouped by diversified address (each peer gets a unique
 * address). FROST coordination, contact cards, text, data memos all render
 * inline within their conversation thread.
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../../state';
import {
  inboxSelector,
  selectConversations,
  selectUnreadCount,
  type Conversation,
  type InboxMessage,
} from '../../../state/inbox';
import { messagesSelector, type Message } from '../../../state/messages';
import { contactsSelector } from '../../../state/contacts';
import {
  selectActiveNetwork,
  selectPenumbraAccount,
  selectEffectiveKeyInfo,
} from '../../../state/keyring';
import { usePenumbraMemos } from '../../../hooks/penumbra-memos';
import { useZcashMemos } from '../../../hooks/zcash-memos';
import { usePenumbraTransaction } from '../../../hooks/penumbra-transaction';
import { useActiveAddress } from '../../../hooks/use-address';
import { TransactionPlannerRequest } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { Address } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';
import { MemoPlaintext } from '@penumbra-zone/protobuf/penumbra/core/transaction/v1/transaction_pb';
import { Value } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { FeeTier_Tier } from '@penumbra-zone/protobuf/penumbra/core/component/fee/v1/fee_pb';
import { viewClient } from '../../../clients';
import { cn } from '@repo/ui/lib/utils';
import { PopupPath } from '../paths';
import { AddContactDialog } from '../../../components/add-contact-dialog';
import { localExtStorage } from '@repo/storage-chrome/local';
import {
  traceAddressReferral,
  type DiversifiedAddressRecord,
} from '@repo/wallet/networks/zcash/diversified-address';
import { MemoType, type ContactCard, decodeDataMemo, DataContentType } from '@repo/wallet/networks/zcash/memo-codec';

// ---- helpers ----

function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const dateDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.floor((today.getTime() - dateDay.getTime()) / 86_400_000);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (diffDays === 0) return time;
  if (diffDays === 1) return `Yesterday ${time}`;
  if (diffDays < 7) {
    return `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  }
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function truncateAddress(addr: string, len = 8): string {
  if (addr.length <= len * 2 + 3) return addr;
  return `${addr.slice(0, len)}...${addr.slice(-6)}`;
}

function memoTypeIcon(type: MemoType): string {
  switch (type) {
    case MemoType.Text: return 'i-lucide-message-square';
    case MemoType.ContactCard: return 'i-lucide-contact';
    case MemoType.Data: return 'i-lucide-database';
    case MemoType.Address: return 'i-lucide-link';
    case MemoType.PaymentRequest: return 'i-lucide-credit-card';
    case MemoType.Ack: return 'i-lucide-check-check';
    case MemoType.EncryptedMessage: return 'i-lucide-lock';
    case MemoType.DkgRound1:
    case MemoType.DkgRound2:
    case MemoType.DkgRound3: return 'i-lucide-key-round';
    case MemoType.SignRequest:
    case MemoType.SignCommitment:
    case MemoType.SignShare:
    case MemoType.SignResult: return 'i-lucide-pen-tool';
    default: return 'i-lucide-file';
  }
}

function isFrostType(type: MemoType): boolean {
  return type >= MemoType.DkgRound1 && type <= MemoType.SignResult;
}

// ---- conversation list ----

function ConversationRow({
  conversation,
  contactName,
  onClick,
}: {
  conversation: Conversation;
  contactName?: string;
  onClick: () => void;
}) {
  const lastMsg = conversation.messages[conversation.messages.length - 1];
  const hasFrost = conversation.messages.some(m => isFrostType(m.type));

  // preview text from last message
  let preview = '';
  if (lastMsg) {
    if (lastMsg.type === MemoType.ContactCard) {
      preview = 'contact card';
    } else if (lastMsg.type === MemoType.Data) {
      preview = 'data payload';
    } else if (isFrostType(lastMsg.type)) {
      preview = lastMsg.typeLabel;
    } else {
      preview = lastMsg.body.slice(0, 80);
    }
  }

  const label = conversation.label ?? contactName ?? `#${conversation.diversifierIndex}`;

  return (
    <button
      className={cn(
        'group relative flex items-start gap-3 rounded-lg border p-3 w-full text-left transition-colors',
        conversation.unread > 0
          ? 'border-primary/40 bg-primary/5 hover:bg-primary/10'
          : 'border-border-hard-soft bg-elev-1 hover:border-border-hard-soft',
      )}
      onClick={onClick}
    >
      {/* unread dot */}
      {conversation.unread > 0 && (
        <div className='absolute left-1 top-1/2 -translate-y-1/2 h-2 w-2 rounded-full bg-zigner-gold' />
      )}

      {/* icon */}
      <div className={cn(
        'flex h-10 w-10 items-center justify-center rounded-full shrink-0',
        hasFrost ? 'bg-yellow-500/10' : 'bg-elev-2',
      )}>
        <span className={cn(
          'h-5 w-5',
          hasFrost ? 'i-lucide-key-round text-yellow-400' : 'i-lucide-message-square text-fg-muted',
        )} />
      </div>

      {/* content */}
      <div className='flex-1 min-w-0'>
        <div className='flex items-center justify-between gap-2'>
          <span className={cn('text-sm truncate', conversation.unread > 0 && 'font-medium')}>
            {label}
          </span>
          <div className='flex items-center gap-1.5 shrink-0'>
            {conversation.unread > 0 && (
              <span className='rounded-full bg-zigner-gold px-1.5 py-0.5 text-[10px] text-zigner-dark'>
                {conversation.unread}
              </span>
            )}
            {lastMsg?.timestamp && (
              <span className='text-[10px] text-fg-muted whitespace-nowrap'>
                {formatTimestamp(lastMsg.timestamp)}
              </span>
            )}
          </div>
        </div>
        <p className={cn(
          'text-xs mt-0.5 line-clamp-1',
          conversation.unread > 0 ? 'text-fg' : 'text-fg-muted',
        )}>
          {preview}
        </p>
        <div className='flex items-center gap-1.5 mt-1'>
          <span className='text-[10px] text-fg-dim'>
            {conversation.messages.length} message{conversation.messages.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>
    </button>
  );
}

// ---- message bubbles ----

function MessageBubble({ message }: { message: InboxMessage }) {
  const isOutgoing = message.direction === 'outgoing';

  return (
    <div className={cn('flex', isOutgoing ? 'justify-end' : 'justify-start')}>
      <div className={cn(
        'max-w-[85%] rounded-xl px-3 py-2',
        isOutgoing
          ? 'bg-primary/15 rounded-br-sm'
          : 'bg-elev-2/60 rounded-bl-sm',
      )}>
        {/* type badge for non-text */}
        {message.type !== MemoType.Text && (
          <div className='flex items-center gap-1 mb-1'>
            <span className={cn(memoTypeIcon(message.type), 'h-3 w-3 text-fg-muted')} />
            <span className='text-[10px] text-fg-muted'>{message.typeLabel}</span>
          </div>
        )}

        {/* render by type */}
        <MessageContent message={message} />

        {/* meta */}
        <div className='flex items-center gap-2 mt-1'>
          {message.timestamp && (
            <span className='text-[10px] text-fg-dim'>
              {formatTimestamp(message.timestamp)}
            </span>
          )}
          {!message.complete && (
            <span className='text-[10px] text-yellow-400'>
              incomplete ({message.txids.length} fragments)
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageContent({ message }: { message: InboxMessage }) {
  switch (message.type) {
    case MemoType.Text:
      return <p className='text-sm whitespace-pre-wrap break-words'>{message.body}</p>;

    case MemoType.ContactCard:
      return <ContactCardBubble card={message.contactCard} />;

    case MemoType.Data:
      return <DataBubble body={message.body} />;

    case MemoType.Address:
      return (
        <div className='space-y-1'>
          <p className='text-xs text-fg-muted'>shared address</p>
          <p className='text-xs font-mono break-all'>{message.body}</p>
        </div>
      );

    case MemoType.PaymentRequest:
      return (
        <div className='space-y-1'>
          <p className='text-xs text-fg-muted'>payment request</p>
          <p className='text-sm font-mono break-all'>{message.body}</p>
        </div>
      );

    case MemoType.Ack:
      return (
        <div className='flex items-center gap-1.5'>
          <span className='i-lucide-check-check h-4 w-4 text-green-400' />
          <span className='text-xs text-green-400'>read receipt</span>
        </div>
      );

    case MemoType.EncryptedMessage:
      return (
        <div className='flex items-center gap-1.5 text-fg-muted'>
          <span className='i-lucide-lock h-4 w-4' />
          <span className='text-xs'>encrypted message (decryption not yet supported)</span>
        </div>
      );

    // FROST DKG
    case MemoType.DkgRound1:
    case MemoType.DkgRound2:
    case MemoType.DkgRound3:
      return <FrostDkgBubble message={message} />;

    // FROST signing
    case MemoType.SignRequest:
    case MemoType.SignCommitment:
    case MemoType.SignShare:
    case MemoType.SignResult:
      return <FrostSignBubble message={message} />;

    default:
      return <p className='text-xs font-mono text-fg-muted break-all'>{message.body}</p>;
  }
}

function ContactCardBubble({ card }: { card?: ContactCard }) {
  const { findByAddress, addContact, addAddress } = useStore(contactsSelector);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (card?.address) {
      setSaved(!!findByAddress(card.address));
    }
  }, [card, findByAddress]);

  if (!card) return <p className='text-xs text-fg-muted'>malformed contact card</p>;

  const handleSave = async () => {
    const contact = await addContact({ name: card.name || 'unnamed' });
    await addAddress(contact.id, { network: 'zcash', address: card.address });
    setSaved(true);
  };

  return (
    <div className='space-y-2'>
      <div className='flex items-center gap-2'>
        <span className='i-lucide-contact h-4 w-4 text-zigner-gold' />
        <span className='text-sm font-medium'>{card.name || 'anonymous'}</span>
      </div>
      <p className='text-[10px] font-mono text-fg-muted break-all'>{card.address}</p>
      {card.zid && (
        <div className='flex items-center gap-1'>
          <span className='i-lucide-fingerprint h-3 w-3 text-fg-muted' />
          <span className='text-[10px] font-mono text-fg-muted'>
            zid{card.zid.slice(0, 16)}
          </span>
        </div>
      )}
      {saved ? (
        <span className='flex items-center gap-1 text-[10px] text-green-400'>
          <span className='i-lucide-check h-3 w-3' />
          in contacts
        </span>
      ) : (
        <button
          onClick={() => void handleSave()}
          className='flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-[10px] text-zigner-gold hover:bg-primary/20 transition-colors'
        >
          <span className='i-lucide-user-plus h-3 w-3' />
          save to contacts
        </button>
      )}
    </div>
  );
}

function DataBubble({ body }: { body: string }) {
  const [expanded, setExpanded] = useState(false);

  // try to decode hex body as data memo
  let display: string;
  let contentType = 'raw';
  try {
    const bytes = new Uint8Array(body.match(/.{2}/g)?.map(b => parseInt(b, 16)) ?? []);
    const decoded = decodeDataMemo(bytes);
    if (decoded) {
      switch (decoded.contentType) {
        case DataContentType.Json:
          contentType = 'json';
          display = new TextDecoder().decode(decoded.data);
          try { display = JSON.stringify(JSON.parse(display), null, 2); } catch { /* keep raw */ }
          break;
        case DataContentType.Cbor:
          contentType = 'cbor';
          display = `[CBOR ${decoded.data.length} bytes]`;
          break;
        case DataContentType.Protobuf:
          contentType = 'protobuf';
          display = `[Protobuf ${decoded.data.length} bytes]`;
          break;
        default:
          display = `[raw ${decoded.data.length} bytes]`;
      }
      if (decoded.correlationId) {
        const cid = Array.from(decoded.correlationId).map(b => b.toString(16).padStart(2, '0')).join('');
        display = `correlation: ${cid}\n${display}`;
      }
      if (decoded.replyTo) {
        display = `reply-to: ${decoded.replyTo}\n${display}`;
      }
    } else {
      display = body;
    }
  } catch {
    display = body;
  }

  return (
    <div className='space-y-1'>
      <div className='flex items-center gap-2'>
        <span className='rounded bg-elev-2 px-1.5 py-0.5 text-[10px] text-fg-muted'>
          {contentType}
        </span>
        <button
          onClick={() => setExpanded(!expanded)}
          className='text-[10px] text-zigner-gold hover:underline'
        >
          {expanded ? 'collapse' : 'expand'}
        </button>
      </div>
      {expanded && (
        <pre className='text-[10px] font-mono text-fg-muted bg-background/50 rounded p-2 overflow-x-auto max-h-48 whitespace-pre-wrap break-all'>
          {display}
        </pre>
      )}
    </div>
  );
}

function FrostDkgBubble({ message }: { message: InboxMessage }) {
  const navigate = useNavigate();
  const round = message.type === MemoType.DkgRound1 ? 1
    : message.type === MemoType.DkgRound2 ? 2 : 3;

  return (
    <div className='space-y-2'>
      <div className='flex items-center gap-2'>
        <span className='i-lucide-key-round h-4 w-4 text-yellow-400' />
        <span className='text-sm font-medium text-yellow-400'>DKG round {round}</span>
      </div>
      <p className='text-[10px] text-fg-muted'>
        {round === 1 && 'key generation started - share your commitment'}
        {round === 2 && 'commitments collected - share your package'}
        {round === 3 && 'packages collected - finalize key generation'}
      </p>
      {message.direction === 'incoming' && (
        <button
          onClick={() => navigate(PopupPath.MULTISIG_JOIN)}
          className='flex items-center gap-1.5 rounded-md bg-yellow-500/10 border border-yellow-500/30 px-2.5 py-1.5 text-xs text-yellow-400 hover:bg-yellow-500/20 transition-colors'
        >
          <span className='i-lucide-arrow-right h-3.5 w-3.5' />
          open multisig
        </button>
      )}
    </div>
  );
}

function FrostSignBubble({ message }: { message: InboxMessage }) {
  const navigate = useNavigate();
  const labels: Record<number, string> = {
    [MemoType.SignRequest]: 'signature requested',
    [MemoType.SignCommitment]: 'commitment shared',
    [MemoType.SignShare]: 'signature share received',
    [MemoType.SignResult]: 'signature complete',
  };

  return (
    <div className='space-y-2'>
      <div className='flex items-center gap-2'>
        <span className='i-lucide-pen-tool h-4 w-4 text-blue-400' />
        <span className='text-sm font-medium text-blue-400'>{message.typeLabel}</span>
      </div>
      <p className='text-[10px] text-fg-muted'>
        {labels[message.type] ?? 'FROST signing round'}
      </p>
      {message.direction === 'incoming' && message.type === MemoType.SignRequest && (
        <button
          onClick={() => navigate(PopupPath.MULTISIG_SIGN)}
          className='flex items-center gap-1.5 rounded-md bg-blue-500/10 border border-blue-500/30 px-2.5 py-1.5 text-xs text-blue-400 hover:bg-blue-500/20 transition-colors'
        >
          <span className='i-lucide-pen-tool h-3.5 w-3.5' />
          sign transaction
        </button>
      )}
      {message.type === MemoType.SignResult && (
        <div className='flex items-center gap-1.5 text-green-400'>
          <span className='i-lucide-check-circle h-3.5 w-3.5' />
          <span className='text-xs'>transaction signed</span>
        </div>
      )}
    </div>
  );
}

// ---- conversation thread view ----

function ConversationThread({
  conversation,
  onClose,
  referral,
}: {
  conversation: Conversation;
  onClose: () => void;
  referral?: DiversifiedAddressRecord;
}) {
  const inbox = useStore(inboxSelector);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState(conversation.label ?? '');

  // scroll to bottom on open
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [conversation.messages.length]);

  // mark as read
  useEffect(() => {
    if (conversation.unread > 0) {
      inbox.markRead(conversation.diversifierIndex);
    }
  }, [conversation.diversifierIndex, conversation.unread, inbox]);

  const saveLabel = () => {
    inbox.setConversationLabel(conversation.diversifierIndex, labelDraft);
    setEditingLabel(false);
  };

  return (
    <div className='flex flex-col h-full'>
      {/* header */}
      <div className='flex items-center gap-3 px-4 py-3 border-b border-border-hard-soft'>
        <button
          onClick={onClose}
          className='text-fg-muted hover:text-fg-high transition-colors'
        >
          <span className='i-lucide-arrow-left h-5 w-5' />
        </button>

        <div className='flex-1 min-w-0'>
          {editingLabel ? (
            <div className='flex items-center gap-2'>
              <input
                value={labelDraft}
                onChange={e => setLabelDraft(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && saveLabel()}
                autoFocus
                className='flex-1 bg-transparent border-b border-zigner-gold text-sm focus:outline-none'
                placeholder='conversation label'
              />
              <button onClick={saveLabel} className='text-zigner-gold'>
                <span className='i-lucide-check h-4 w-4' />
              </button>
              <button onClick={() => setEditingLabel(false)} className='text-fg-muted'>
                <span className='i-lucide-x h-4 w-4' />
              </button>
            </div>
          ) : (
            <button
              onClick={() => {
                setLabelDraft(conversation.label ?? '');
                setEditingLabel(true);
              }}
              className='flex items-center gap-1.5 text-sm font-medium hover:text-zigner-gold transition-colors'
            >
              {conversation.label || `conversation #${conversation.diversifierIndex}`}
              <span className='i-lucide-pencil h-3 w-3 text-fg-muted' />
            </button>
          )}
        </div>

        <span className='text-[10px] text-fg-muted'>
          {conversation.messages.length} msg
        </span>
      </div>

      {/* referral attribution */}
      {referral && (
        <div className='flex items-center gap-1.5 px-4 py-2 text-xs text-blue-400 border-b border-border-hard/20'>
          <span className='i-lucide-share-2 h-3.5 w-3.5' />
          via {referral.sharedWith}
        </div>
      )}

      {/* messages */}
      <div ref={scrollRef} className='flex-1 overflow-y-auto px-4 py-3 space-y-3'>
        {conversation.messages.map(msg => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
      </div>

      {/* compose bar */}
      <ConversationCompose diversifierIndex={conversation.diversifierIndex} />
    </div>
  );
}

function ConversationCompose({ diversifierIndex }: { diversifierIndex: number }) {
  const navigate = useNavigate();
  const activeNetwork = useStore(selectActiveNetwork);
  const { address: ownAddress } = useActiveAddress();
  const [message, setMessage] = useState('');

  const handleSend = () => {
    if (!message.trim()) return;

    const memoWithReply = ownAddress
      ? `${message}\nreply:${ownAddress}`
      : message;

    navigate(PopupPath.SEND, {
      state: {
        prefillMemo: memoWithReply,
        prefillAmount: '',
        diversifierIndex,
      },
    });
  };

  return (
    <div className='p-3 border-t border-border-hard-soft'>
      <div className='flex items-end gap-2'>
        <textarea
          value={message}
          onChange={e => setMessage(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder='write a message...'
          rows={1}
          className='flex-1 rounded-lg border border-border-hard-soft bg-input px-3 py-2 text-sm focus:border-zigner-gold focus:outline-none resize-none'
        />
        <button
          onClick={handleSend}
          disabled={!message.trim()}
          className='rounded-lg bg-zigner-gold p-2 text-zigner-dark hover:bg-zigner-gold-light transition-colors disabled:opacity-50'
        >
          <span className='i-lucide-send h-4 w-4' />
        </button>
      </div>
      <p className='text-[10px] text-fg-muted mt-1'>
        sends via {activeNetwork} shielded transaction
      </p>
    </div>
  );
}

// ---- compose new conversation ----

function ComposeMessage({
  onClose,
  replyTo,
  network,
}: {
  onClose: () => void;
  replyTo?: { address: string; network: 'zcash' | 'penumbra' };
  network: 'zcash' | 'penumbra';
}) {
  const navigate = useNavigate();
  const penumbraTx = usePenumbraTransaction();
  const penumbraAccount = useStore(selectPenumbraAccount);
  const { address: ownAddress } = useActiveAddress();
  const [recipient, setRecipient] = useState(replyTo?.address ?? '');
  const [message, setMessage] = useState('');
  const [amount, setAmount] = useState('');
  const [txStatus, setTxStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [txError, setTxError] = useState<string | undefined>();
  const [txHash, setTxHash] = useState<string | undefined>();

  const canSend = recipient.trim() && message.trim() && txStatus === 'idle';

  const handleSendPenumbra = useCallback(async () => {
    if (!recipient.trim() || !message.trim()) return;

    setTxStatus('sending');
    setTxError(undefined);

    try {
      const addressResponse = await viewClient.addressByIndex({
        addressIndex: { account: penumbraAccount },
      });
      if (!addressResponse.address) throw new Error('failed to get address');

      const amountValue = amount ? parseFloat(amount) : 0.000001;
      const amountInMicroUM = BigInt(Math.floor(amountValue * 1_000_000));

      const planRequest = new TransactionPlannerRequest({
        source: { account: penumbraAccount },
        outputs: [{
          address: new Address({ altBech32m: recipient }),
          value: new Value({
            amount: { lo: amountInMicroUM, hi: 0n },
          }),
        }],
        memo: new MemoPlaintext({
          returnAddress: addressResponse.address,
          text: message,
        }),
        feeMode: {
          case: 'autoFee',
          value: { feeTier: FeeTier_Tier.LOW },
        },
      });

      const result = await penumbraTx.mutateAsync(planRequest);
      setTxStatus('success');
      setTxHash(result.txId);
    } catch (err) {
      setTxStatus('error');
      setTxError(err instanceof Error ? err.message : 'failed to send');
    }
  }, [recipient, message, amount, penumbraTx, penumbraAccount]);

  const handleSendZcash = useCallback(() => {
    const memoWithReply = ownAddress
      ? `${message}\nreply:${ownAddress}`
      : message;

    navigate(PopupPath.SEND, {
      state: {
        prefillMemo: memoWithReply,
        prefillRecipient: recipient,
        prefillAmount: amount,
      },
    });
    onClose();
  }, [navigate, message, recipient, amount, ownAddress, onClose]);

  const handleSend = () => {
    if (!canSend) return;
    if (network === 'penumbra') {
      void handleSendPenumbra();
    } else {
      handleSendZcash();
    }
  };

  return (
    <div className='flex flex-col h-full'>
      <div className='flex items-center gap-3 px-4 py-3 border-b border-border-hard-soft'>
        <button onClick={onClose} className='text-fg-muted hover:text-fg-high transition-colors'>
          <span className='i-lucide-arrow-left h-5 w-5' />
        </button>
        <h2 className='text-lg font-medium'>new message</h2>
      </div>

      <div className='flex-1 overflow-y-auto p-4 space-y-4'>
        <div>
          <label className='block text-xs text-fg-muted mb-1'>to</label>
          <input
            type='text'
            value={recipient}
            onChange={e => setRecipient(e.target.value)}
            placeholder={network === 'zcash' ? 'z-address or unified address' : 'penumbra1...'}
            disabled={!!replyTo || txStatus !== 'idle'}
            className='w-full rounded-lg border border-border-hard-soft bg-input px-3 py-2.5 text-xs font-mono focus:border-zigner-gold focus:outline-none disabled:opacity-50'
          />
        </div>

        <div>
          <label className='block text-xs text-fg-muted mb-1'>
            amount ({network === 'penumbra' ? 'um' : 'zec'})
          </label>
          <input
            type='text'
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder='0.00 (optional)'
            disabled={txStatus !== 'idle'}
            className='w-full rounded-lg border border-border-hard-soft bg-input px-3 py-2.5 text-sm focus:border-zigner-gold focus:outline-none disabled:opacity-50'
          />
          <p className='text-xs text-fg-muted mt-1'>send a payment with your message</p>
        </div>

        <div>
          <label className='block text-xs text-fg-muted mb-1'>message</label>
          <textarea
            value={message}
            onChange={e => setMessage(e.target.value)}
            placeholder='write your encrypted message...'
            rows={6}
            maxLength={network === 'zcash' && ownAddress ? 512 - ownAddress.length - 7 : 512}
            disabled={txStatus !== 'idle'}
            className='w-full rounded-lg border border-border-hard-soft bg-input px-3 py-2.5 text-sm focus:border-zigner-gold focus:outline-none resize-none disabled:opacity-50'
          />
          <p className='text-xs text-fg-muted mt-1'>
            {message.length}/{network === 'zcash' && ownAddress ? 512 - ownAddress.length - 7 : 512} characters
            {network === 'zcash' && ownAddress && (
              <span className='ml-1 text-fg-dim'>(return address reserved)</span>
            )}
          </p>
        </div>

        {txStatus === 'success' && txHash && (
          <div className='rounded-lg border border-green-500/40 bg-green-500/10 p-3'>
            <p className='text-sm text-green-400'>message sent!</p>
            <p className='text-xs text-fg-muted mt-1 font-mono break-all'>{txHash}</p>
          </div>
        )}

        {txStatus === 'error' && txError && (
          <div className='rounded-lg border border-red-500/40 bg-red-500/10 p-3'>
            <p className='text-sm text-red-400'>failed to send</p>
            <p className='text-xs text-fg-muted mt-1'>{txError}</p>
          </div>
        )}
      </div>

      <div className='p-4 border-t border-border-hard-soft'>
        <button
          onClick={() => {
            if (txStatus === 'success' || txStatus === 'error') onClose();
            else handleSend();
          }}
          disabled={(txStatus === 'idle' && !canSend) || txStatus === 'sending'}
          className='w-full flex items-center justify-center gap-2 rounded-lg bg-zigner-gold py-3 text-sm font-medium text-zigner-dark hover:bg-zigner-gold-light transition-colors disabled:opacity-50'
        >
          {txStatus === 'sending' ? (
            <><span className='i-lucide-refresh-cw h-4 w-4 animate-spin' /> sending...</>
          ) : txStatus === 'success' ? (
            <><span className='i-lucide-check h-4 w-4' /> done</>
          ) : txStatus === 'error' ? (
            'close'
          ) : (
            <><span className='i-lucide-send h-4 w-4' /> send message</>
          )}
        </button>
        <p className='text-xs text-fg-muted text-center mt-2'>
          {network === 'penumbra'
            ? 'message will be encrypted in penumbra memo'
            : 'will open zcash send flow'}
        </p>
      </div>
    </div>
  );
}

// ---- main inbox page ----

export function InboxPage() {
  const conversations = useStore(selectConversations);
  const unreadCount = useStore(selectUnreadCount);
  const messages = useStore(messagesSelector);
  const contacts = useStore(contactsSelector);
  const activeNetwork = useStore(selectActiveNetwork);
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';

  const [selectedConvo, setSelectedConvo] = useState<Conversation | undefined>();
  const [showCompose, setShowCompose] = useState(false);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'conversations' | 'all'>('conversations');
  const [addContactData, setAddContactData] = useState<{ address: string; network: 'zcash' | 'penumbra' } | null>(null);

  const walletId = selectedKeyInfo?.id ?? '';

  // memo sync
  const { syncMemos: syncPenumbraMemos, isSyncing: isPenumbraSyncing, syncProgress } = usePenumbraMemos();
  const { syncMemos: syncZcashMemos, isSyncing: isZcashSyncing, syncProgress: zcashSyncProgress } = useZcashMemos(walletId, zidecarUrl);
  const isSyncing = isPenumbraSyncing || isZcashSyncing;
  const currentSyncProgress = activeNetwork === 'zcash' ? zcashSyncProgress : syncProgress;

  // auto-sync on mount
  useEffect(() => {
    if (activeNetwork === 'penumbra') syncPenumbraMemos();
    else if (activeNetwork === 'zcash' && walletId) syncZcashMemos();
  }, [activeNetwork, walletId, syncPenumbraMemos, syncZcashMemos]);

  // diversified address records for referral tracking
  const [addressRecords, setAddressRecords] = useState<DiversifiedAddressRecord[]>([]);
  useEffect(() => {
    void localExtStorage.get('diversifiedAddresses').then(r => setAddressRecords(r ?? []));
  }, []);

  // filter conversations by search
  const filteredConversations = useMemo(() => {
    if (!search) return conversations;
    const q = search.toLowerCase();
    return conversations.filter(c =>
      c.label?.toLowerCase().includes(q) ||
      c.messages.some(m => m.body.toLowerCase().includes(q))
    );
  }, [conversations, search]);

  // flat messages view (penumbra + legacy)
  const flatMessages = useMemo(() => {
    const all = tab === 'all'
      ? messages.getInbox().filter(m => m.network === activeNetwork)
      : [];

    if (!search) return all;
    const q = search.toLowerCase();
    return all.filter(m =>
      m.content.toLowerCase().includes(q) ||
      m.senderAddress?.toLowerCase().includes(q)
    );
  }, [messages, tab, search, activeNetwork]);

  const getContactName = useCallback(
    (address: string | undefined) => {
      if (!address) return undefined;
      return contacts.findByAddress(address)?.contact.name;
    },
    [contacts],
  );

  // referral for selected conversation
  const selectedReferral = useMemo(() => {
    if (!selectedConvo || addressRecords.length === 0) return undefined;
    return traceAddressReferral(addressRecords, selectedConvo.diversifierIndex);
  }, [selectedConvo, addressRecords]);

  // ---- render thread view ----
  if (selectedConvo) {
    return (
      <ConversationThread
        conversation={selectedConvo}
        onClose={() => setSelectedConvo(undefined)}
        referral={selectedReferral}
      />
    );
  }

  // ---- render compose ----
  if (showCompose) {
    return (
      <ComposeMessage
        onClose={() => setShowCompose(false)}
        network={activeNetwork as 'zcash' | 'penumbra'}
      />
    );
  }

  // ---- render conversation list ----
  return (
    <div className='flex flex-col h-full'>
      {/* header */}
      <div className='flex items-center justify-between px-4 py-3 border-b border-border-hard-soft'>
        <div className='flex items-center gap-2'>
          <h1 className='text-lg font-medium'>inbox</h1>
          {isSyncing && (
            <span className='flex items-center gap-1 text-xs text-fg-muted'>
              <span className='i-lucide-refresh-cw h-3 w-3 animate-spin' />
              syncing{currentSyncProgress ? ` (${currentSyncProgress.current})` : '...'}
            </span>
          )}
        </div>
        <div className='flex items-center gap-2'>
          <button
            onClick={() => {
              if (activeNetwork === 'zcash' && walletId) syncZcashMemos();
              else syncPenumbraMemos();
            }}
            disabled={isSyncing}
            className='rounded-lg p-1.5 hover:bg-elev-1 transition-colors disabled:opacity-50'
            title='sync messages'
          >
            <span className={cn('i-lucide-refresh-cw h-4 w-4', isSyncing && 'animate-spin')} />
          </button>
          <button
            onClick={() => setShowCompose(true)}
            className='flex items-center gap-1 rounded-lg bg-zigner-gold px-3 py-1.5 text-sm font-medium text-zigner-dark hover:bg-zigner-gold-light transition-colors'
          >
            <span className='i-lucide-send h-4 w-4' />
            compose
          </button>
        </div>
      </div>

      {/* tabs */}
      <div className='flex border-b border-border-hard-soft'>
        <button
          onClick={() => setTab('conversations')}
          className={cn(
            'flex-1 py-2.5 text-sm font-medium border-b-2 transition-colors',
            tab === 'conversations'
              ? 'border-zigner-gold text-fg'
              : 'border-transparent text-fg-muted hover:text-fg-high',
          )}
        >
          conversations
          {unreadCount > 0 && (
            <span className='ml-1.5 rounded-full bg-zigner-gold px-1.5 py-0.5 text-[10px] text-zigner-dark'>
              {unreadCount}
            </span>
          )}
        </button>
        <button
          onClick={() => setTab('all')}
          className={cn(
            'flex-1 py-2.5 text-sm font-medium border-b-2 transition-colors',
            tab === 'all'
              ? 'border-zigner-gold text-fg'
              : 'border-transparent text-fg-muted hover:text-fg-high',
          )}
        >
          all messages
        </button>
      </div>

      {/* search */}
      <div className='px-4 py-3'>
        <div className='relative'>
          <span className='i-lucide-search absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-fg-muted' />
          <input
            type='text'
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={tab === 'conversations' ? 'search conversations...' : 'search messages...'}
            className='w-full rounded-lg border border-border-hard-soft bg-input pl-9 pr-3 py-2.5 text-sm focus:border-zigner-gold focus:outline-none'
          />
        </div>
      </div>

      {/* content */}
      <div className='flex-1 overflow-y-auto px-4 pb-4'>
        {tab === 'conversations' ? (
          filteredConversations.length === 0 ? (
            <EmptyState text='no conversations' subtitle={`encrypted ${activeNetwork} conversations will appear here`} />
          ) : (
            <div className='space-y-2'>
              {filteredConversations.map(convo => (
                <ConversationRow
                  key={convo.diversifierIndex}
                  conversation={convo}
                  contactName={getContactName(
                    convo.messages.find(m => m.direction === 'incoming')
                      ? undefined // we don't know the address from inbox state alone
                      : undefined
                  )}
                  onClick={() => setSelectedConvo(convo)}
                />
              ))}
            </div>
          )
        ) : (
          flatMessages.length === 0 ? (
            <EmptyState text='no messages' subtitle={`${activeNetwork} messages will appear here`} />
          ) : (
            <div className='space-y-2'>
              {flatMessages.map(msg => (
                <FlatMessageRow
                  key={msg.id}
                  message={msg}
                  contactName={getContactName(msg.senderAddress)}
                  onClick={() => {
                    // find conversation containing this message
                    const convo = conversations.find(c =>
                      c.messages.some(m => m.txids.includes(msg.txId))
                    );
                    if (convo) setSelectedConvo(convo);
                  }}
                />
              ))}
            </div>
          )
        )}
      </div>

      {addContactData && (
        <AddContactDialog
          address={addContactData.address}
          network={addContactData.network}
          onClose={() => setAddContactData(null)}
        />
      )}
    </div>
  );
}

function FlatMessageRow({
  message,
  contactName,
  onClick,
}: {
  message: Message;
  contactName?: string;
  onClick: () => void;
}) {
  const displayAddress = message.direction === 'received'
    ? message.senderAddress ?? 'shielded sender'
    : message.recipientAddress;

  return (
    <button
      className={cn(
        'flex items-start gap-3 rounded-lg border p-3 w-full text-left transition-colors',
        message.read
          ? 'border-border-hard-soft bg-elev-1 hover:border-border-hard-soft'
          : 'border-primary/40 bg-primary/5 hover:bg-primary/10',
      )}
      onClick={onClick}
    >
      <div className='flex h-8 w-8 items-center justify-center rounded-full bg-elev-2 shrink-0'>
        <span className={cn(
          'h-4 w-4',
          message.read ? 'i-lucide-mail-open text-fg-muted' : 'i-lucide-mail text-zigner-gold',
        )} />
      </div>
      <div className='flex-1 min-w-0'>
        <div className='flex items-center justify-between gap-2'>
          <span className={cn('text-sm truncate', !message.read && 'font-medium')}>
            {contactName ?? truncateAddress(displayAddress)}
          </span>
          <span className='text-[10px] text-fg-muted whitespace-nowrap'>
            {formatTimestamp(message.timestamp)}
          </span>
        </div>
        <p className={cn(
          'text-xs mt-0.5 line-clamp-1',
          message.read ? 'text-fg-muted' : 'text-fg',
        )}>
          {message.content}
        </p>
        {message.amount && (
          <span className='inline-flex items-center rounded-md bg-green-500/10 px-1.5 py-0.5 mt-1 text-[10px] text-green-400'>
            {message.direction === 'received' ? '+' : '-'}{message.amount} {message.asset ?? ''}
          </span>
        )}
      </div>
    </button>
  );
}

function EmptyState({ text, subtitle }: { text: string; subtitle: string }) {
  return (
    <div className='flex flex-col items-center justify-center gap-3 py-12 text-center'>
      <div className='rounded-full bg-primary/10 p-4'>
        <span className='i-lucide-mail h-8 w-8 text-zigner-gold' />
      </div>
      <div>
        <p className='text-sm font-medium'>{text}</p>
        <p className='text-xs text-fg-muted'>{subtitle}</p>
      </div>
    </div>
  );
}

export default InboxPage;
