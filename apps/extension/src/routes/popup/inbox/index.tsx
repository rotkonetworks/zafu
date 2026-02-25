/**
 * inbox page - encrypted messages from zcash/penumbra memos
 *
 * email-like interface for reading and composing encrypted messages
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  EnvelopeClosedIcon,
  EnvelopeOpenIcon,
  PaperPlaneIcon,
  MagnifyingGlassIcon,
  DotsVerticalIcon,
  CheckIcon,
  TrashIcon,
  ReloadIcon,
  PersonIcon,
} from '@radix-ui/react-icons';
import { useStore } from '../../../state';
import { messagesSelector, type Message } from '../../../state/messages';
import { contactsSelector } from '../../../state/contacts';
import { selectActiveNetwork, selectPenumbraAccount } from '../../../state/keyring';
import { usePenumbraMemos } from '../../../hooks/penumbra-memos';
import { usePenumbraTransaction } from '../../../hooks/penumbra-transaction';
import { TransactionPlannerRequest } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { Address } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';
import { MemoPlaintext } from '@penumbra-zone/protobuf/penumbra/core/transaction/v1/transaction_pb';
import { Value } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { FeeTier_Tier } from '@penumbra-zone/protobuf/penumbra/core/component/fee/v1/fee_pb';
import { viewClient } from '../../../clients';
import { cn } from '@repo/ui/lib/utils';
import { PopupPath } from '../paths';
import { AddContactDialog } from '../../../components/add-contact-dialog';

type TabType = 'inbox' | 'sent';

function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  const now = new Date();

  // Compare calendar days, not 24-hour periods
  const dateDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.floor((today.getTime() - dateDay.getTime()) / (1000 * 60 * 60 * 24));

  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (diffDays === 0) {
    return `Today ${time}`;
  }
  if (diffDays === 1) {
    return `Yesterday ${time}`;
  }
  if (diffDays < 7) {
    const weekday = date.toLocaleDateString([], { weekday: 'short' });
    return `${weekday} ${time}`;
  }
  const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${dateStr} ${time}`;
}

function MessageRow({
  message,
  contactName,
  onClick,
  onMarkRead,
  onDelete,
  onAddToContacts,
  isInContacts,
}: {
  message: Message;
  contactName?: string;
  onClick: () => void;
  onMarkRead: () => void;
  onDelete: () => void;
  onAddToContacts?: () => void;
  isInContacts: boolean;
}) {
  const [showMenu, setShowMenu] = useState(false);

  const displayAddress = message.direction === 'received'
    ? message.senderAddress ?? 'shielded sender'
    : message.recipientAddress;

  const truncatedAddress = displayAddress.length > 20
    ? `${displayAddress.slice(0, 8)}...${displayAddress.slice(-6)}`
    : displayAddress;

  // can add to contacts if we have a valid address and it's not already in contacts
  const canAddToContacts = !isInContacts && onAddToContacts && displayAddress !== 'shielded sender';

  return (
    <div
      className={cn(
        'group relative flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors',
        message.read
          ? 'border-border/30 bg-card hover:border-border'
          : 'border-primary/30 bg-primary/5 hover:bg-primary/10'
      )}
      onClick={onClick}
    >
      {/* unread indicator */}
      {!message.read && (
        <div className='absolute left-1 top-1/2 -translate-y-1/2 h-2 w-2 rounded-full bg-primary' />
      )}

      {/* icon */}
      <div className='flex h-10 w-10 items-center justify-center rounded-full bg-muted/50'>
        {message.read ? (
          <EnvelopeOpenIcon className='h-5 w-5 text-muted-foreground' />
        ) : (
          <EnvelopeClosedIcon className='h-5 w-5 text-primary' />
        )}
      </div>

      {/* content */}
      <div className='flex-1 min-w-0'>
        <div className='flex items-center justify-between gap-2'>
          <span className={cn('text-sm truncate', !message.read && 'font-semibold')}>
            {contactName ?? truncatedAddress}
          </span>
          <span className='text-xs text-muted-foreground whitespace-nowrap'>
            {formatTimestamp(message.timestamp)}
          </span>
        </div>

        <p className={cn(
          'text-sm mt-0.5 line-clamp-2',
          message.read ? 'text-muted-foreground' : 'text-foreground'
        )}>
          {message.content}
        </p>

        {message.amount && (
          <div className='mt-1 inline-flex items-center gap-1 rounded bg-green-500/10 px-1.5 py-0.5'>
            <span className='text-xs text-green-500'>
              {message.direction === 'received' ? '+' : '-'}{message.amount} {message.asset ?? ''}
            </span>
          </div>
        )}

        <div className='flex items-center gap-2 mt-1'>
          <span className='rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground'>
            {message.network}
          </span>
        </div>
      </div>

      {/* actions menu */}
      <div className='relative'>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setShowMenu(!showMenu);
          }}
          className='p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-muted'
        >
          <DotsVerticalIcon className='h-4 w-4 text-muted-foreground' />
        </button>

        {showMenu && (
          <div className='absolute right-0 top-full mt-1 z-10 rounded-lg border border-border bg-background shadow-lg py-1 min-w-[140px]'>
            {!message.read && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onMarkRead();
                  setShowMenu(false);
                }}
                className='flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-muted'
              >
                <CheckIcon className='h-4 w-4' />
                mark read
              </button>
            )}
            {canAddToContacts && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onAddToContacts();
                  setShowMenu(false);
                }}
                className='flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-muted'
              >
                <PersonIcon className='h-4 w-4' />
                add to contacts
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
                setShowMenu(false);
              }}
              className='flex items-center gap-2 w-full px-3 py-1.5 text-sm text-red-500 hover:bg-muted'
            >
              <TrashIcon className='h-4 w-4' />
              delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function MessageDetail({
  message,
  contactName,
  onClose,
  onReply,
  onAddToContacts,
  isInContacts,
}: {
  message: Message;
  contactName?: string;
  onClose: () => void;
  onReply: () => void;
  onAddToContacts?: () => void;
  isInContacts: boolean;
}) {
  const displayAddress = message.direction === 'received'
    ? message.senderAddress ?? 'shielded sender'
    : message.recipientAddress;

  const canAddToContacts = !isInContacts && onAddToContacts && displayAddress !== 'shielded sender';

  return (
    <div className='flex flex-col h-full'>
      {/* header */}
      <div className='flex items-center gap-3 px-4 py-3 border-b border-border/40'>
        <button
          onClick={onClose}
          className='text-muted-foreground hover:text-foreground'
        >
          &larr;
        </button>
        <h2 className='font-medium'>message</h2>
      </div>

      {/* message content */}
      <div className='flex-1 overflow-y-auto p-4'>
        <div className='space-y-4'>
          {/* sender address - full width clickable */}
          <div className='break-all text-sm font-mono text-muted-foreground'>
            {displayAddress}
          </div>

          {/* metadata */}
          <div className='space-y-2'>
            <div className='flex items-center justify-between'>
              <div className='flex items-center gap-2'>
                <span className='text-sm font-medium'>
                  {contactName ?? (displayAddress.length > 20
                    ? `${displayAddress.slice(0, 8)}...${displayAddress.slice(-6)}`
                    : displayAddress)}
                </span>
                {canAddToContacts && (
                  <button
                    onClick={onAddToContacts}
                    className='flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors'
                    title='add to contacts'
                  >
                    <PersonIcon className='h-3 w-3' />
                    add
                  </button>
                )}
              </div>
              <span className='text-xs text-muted-foreground'>
                {new Date(message.timestamp).toLocaleString()}
              </span>
            </div>
            <div className='flex items-center gap-2'>
              <span className='rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground'>
                {message.network}
              </span>
              <span className='text-xs text-muted-foreground font-mono'>
                {message.txId.slice(0, 12)}...
              </span>
            </div>
          </div>

          {/* amount if payment */}
          {message.amount && (
            <div className='rounded-lg border border-green-500/30 bg-green-500/10 p-3'>
              <p className='text-sm text-green-400'>
                {message.direction === 'received' ? 'received' : 'sent'}{' '}
                <span className='font-semibold'>
                  {message.amount} {message.asset ?? ''}
                </span>
              </p>
            </div>
          )}

          {/* message body */}
          <div className='rounded-lg border border-border bg-card p-4'>
            <p className='text-sm whitespace-pre-wrap'>{message.content}</p>
          </div>
        </div>
      </div>

      {/* reply button */}
      {message.direction === 'received' && message.senderAddress && (
        <div className='p-4 border-t border-border/40'>
          <button
            onClick={onReply}
            className='w-full flex items-center justify-center gap-2 rounded-lg bg-zigner-gold py-2.5 text-sm font-medium text-zigner-dark'
          >
            <PaperPlaneIcon className='h-4 w-4' />
            reply
          </button>
        </div>
      )}
    </div>
  );
}

function ComposeMessage({
  onClose,
  replyTo,
}: {
  onClose: () => void;
  replyTo?: { address: string; network: 'zcash' | 'penumbra' };
}) {
  const navigate = useNavigate();
  const penumbraTx = usePenumbraTransaction();
  const penumbraAccount = useStore(selectPenumbraAccount);
  const [recipient, setRecipient] = useState(replyTo?.address ?? '');
  const [network, setNetwork] = useState<'zcash' | 'penumbra'>(replyTo?.network ?? 'penumbra');
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
      // get our address for return address in memo
      const addressResponse = await viewClient.addressByIndex({
        addressIndex: { account: penumbraAccount },
      });

      if (!addressResponse.address) {
        throw new Error('failed to get address');
      }

      // build minimal amount (required for penumbra sends)
      // for message-only sends, we send a tiny amount of UM
      const amountValue = amount ? parseFloat(amount) : 0.000001;
      const amountInMicroUM = BigInt(Math.floor(amountValue * 1_000_000));

      // create transaction plan request
      const planRequest = new TransactionPlannerRequest({
        source: { account: penumbraAccount },
        outputs: [
          {
            address: new Address({ altBech32m: recipient }),
            value: new Value({
              amount: { lo: amountInMicroUM, hi: 0n },
              // UM asset id - this is the staking token
            }),
          },
        ],
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
  }, [recipient, message, amount, penumbraTx]);

  const handleSendZcash = useCallback(() => {
    // navigate to zcash send page with pre-filled memo
    // the zcash send page will handle the actual transaction
    navigate(PopupPath.SEND, {
      state: {
        prefillMemo: message,
        prefillRecipient: recipient,
        prefillAmount: amount,
      },
    });
    onClose();
  }, [navigate, message, recipient, amount, onClose]);

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
      {/* header */}
      <div className='flex items-center gap-3 px-4 py-3 border-b border-border/40'>
        <button
          onClick={onClose}
          className='text-muted-foreground hover:text-foreground'
        >
          &larr;
        </button>
        <h2 className='font-medium'>compose</h2>
      </div>

      {/* form */}
      <div className='flex-1 overflow-y-auto p-4 space-y-4'>
        <div>
          <label className='block text-xs text-muted-foreground mb-1'>network</label>
          <select
            value={network}
            onChange={(e) => setNetwork(e.target.value as 'zcash' | 'penumbra')}
            disabled={!!replyTo || txStatus !== 'idle'}
            className='w-full rounded-lg border border-border bg-input px-3 py-2 text-sm focus:border-zigner-gold focus:outline-none disabled:opacity-50'
          >
            <option value='penumbra'>penumbra</option>
            <option value='zcash'>zcash</option>
          </select>
        </div>

        <div>
          <label className='block text-xs text-muted-foreground mb-1'>to</label>
          <input
            type='text'
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder={network === 'zcash' ? 'z-address or unified address' : 'penumbra1...'}
            disabled={!!replyTo || txStatus !== 'idle'}
            className='w-full rounded-lg border border-border bg-input px-3 py-2 text-sm font-mono text-xs focus:border-zigner-gold focus:outline-none disabled:opacity-50'
          />
        </div>

        <div>
          <label className='block text-xs text-muted-foreground mb-1'>
            amount ({network === 'penumbra' ? 'um' : 'zec'})
          </label>
          <input
            type='text'
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder='0.00 (optional)'
            disabled={txStatus !== 'idle'}
            className='w-full rounded-lg border border-border bg-input px-3 py-2 text-sm focus:border-zigner-gold focus:outline-none disabled:opacity-50'
          />
          <p className='text-xs text-muted-foreground mt-1'>
            send a payment with your message
          </p>
        </div>

        <div>
          <label className='block text-xs text-muted-foreground mb-1'>message</label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder='write your encrypted message...'
            rows={6}
            maxLength={512}
            disabled={txStatus !== 'idle'}
            className='w-full rounded-lg border border-border bg-input px-3 py-2 text-sm focus:border-zigner-gold focus:outline-none resize-none disabled:opacity-50'
          />
          <p className='text-xs text-muted-foreground mt-1'>
            {message.length}/512 characters
          </p>
        </div>

        {/* transaction status */}
        {txStatus === 'success' && txHash && (
          <div className='rounded-lg border border-green-500/30 bg-green-500/10 p-3'>
            <p className='text-sm text-green-400'>message sent!</p>
            <p className='text-xs text-muted-foreground mt-1 font-mono break-all'>
              {txHash}
            </p>
          </div>
        )}

        {txStatus === 'error' && txError && (
          <div className='rounded-lg border border-red-500/30 bg-red-500/10 p-3'>
            <p className='text-sm text-red-400'>failed to send</p>
            <p className='text-xs text-muted-foreground mt-1'>{txError}</p>
          </div>
        )}
      </div>

      {/* send button */}
      <div className='p-4 border-t border-border/40'>
        <button
          onClick={() => {
            if (txStatus === 'success' || txStatus === 'error') {
              onClose();
            } else {
              handleSend();
            }
          }}
          disabled={txStatus === 'idle' && !canSend || txStatus === 'sending'}
          className='w-full flex items-center justify-center gap-2 rounded-lg bg-zigner-gold py-2.5 text-sm font-medium text-zigner-dark disabled:opacity-50'
        >
          {txStatus === 'sending' ? (
            <>
              <ReloadIcon className='h-4 w-4 animate-spin' />
              sending...
            </>
          ) : txStatus === 'success' ? (
            <>
              <CheckIcon className='h-4 w-4' />
              done
            </>
          ) : txStatus === 'error' ? (
            'close'
          ) : (
            <>
              <PaperPlaneIcon className='h-4 w-4' />
              send message
            </>
          )}
        </button>
        <p className='text-xs text-muted-foreground text-center mt-2'>
          {network === 'penumbra'
            ? 'message will be encrypted in penumbra memo'
            : 'will open zcash send flow'}
        </p>
      </div>
    </div>
  );
}

export function InboxPage() {
  const messages = useStore(messagesSelector);
  const contacts = useStore(contactsSelector);
  const activeNetwork = useStore(selectActiveNetwork);
  const [tab, setTab] = useState<TabType>('inbox');
  const [search, setSearch] = useState('');
  const [selectedMessage, setSelectedMessage] = useState<Message | undefined>();
  const [showCompose, setShowCompose] = useState(false);
  const [replyTo, setReplyTo] = useState<{ address: string; network: 'zcash' | 'penumbra' } | undefined>();
  const [addContactData, setAddContactData] = useState<{ address: string; network: 'zcash' | 'penumbra' } | null>(null);

  // memo sync hooks
  const { syncMemos: syncPenumbraMemos, isSyncing: isPenumbraSyncing, syncProgress } = usePenumbraMemos();

  const unreadCount = messages.getUnreadCount();

  // auto-sync on mount for penumbra
  useEffect(() => {
    if (activeNetwork === 'penumbra') {
      syncPenumbraMemos();
    }
  }, [activeNetwork, syncPenumbraMemos]);

  const displayedMessages = useMemo(() => {
    let result = tab === 'inbox' ? messages.getInbox() : messages.getSent();

    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (m) =>
          m.content.toLowerCase().includes(q) ||
          m.senderAddress?.toLowerCase().includes(q) ||
          m.recipientAddress.toLowerCase().includes(q)
      );
    }

    return result;
  }, [messages, tab, search]);

  const getContactName = useCallback(
    (address: string | undefined) => {
      if (!address) return undefined;
      const result = contacts.findByAddress(address);
      return result?.contact.name;
    },
    [contacts]
  );

  const handleSelectMessage = useCallback(
    (message: Message) => {
      setSelectedMessage(message);
      if (!message.read) {
        void messages.markRead(message.id);
      }
    },
    [messages]
  );

  const handleReply = useCallback(() => {
    if (selectedMessage?.senderAddress) {
      setReplyTo({
        address: selectedMessage.senderAddress,
        network: selectedMessage.network,
      });
      setShowCompose(true);
      setSelectedMessage(undefined);
    }
  }, [selectedMessage]);

  const handleAddToContacts = useCallback(
    (address: string, network: 'zcash' | 'penumbra') => {
      // check if already in contacts
      if (contacts.findByAddress(address)) return;
      // show dialog to add contact
      setAddContactData({ address, network });
    },
    [contacts]
  );

  const isAddressInContacts = useCallback(
    (address: string | undefined) => {
      if (!address) return true; // treat undefined as "in contacts" to hide button
      return !!contacts.findByAddress(address);
    },
    [contacts]
  );

  // compute selected message address for MessageDetail
  const selectedAddress = selectedMessage
    ? selectedMessage.direction === 'received'
      ? selectedMessage.senderAddress
      : selectedMessage.recipientAddress
    : undefined;

  // show message detail
  if (selectedMessage) {
    return (
      <>
        <MessageDetail
          message={selectedMessage}
          contactName={getContactName(selectedAddress)}
          onClose={() => setSelectedMessage(undefined)}
          onReply={handleReply}
          onAddToContacts={selectedAddress ? () => handleAddToContacts(selectedAddress, selectedMessage.network) : undefined}
          isInContacts={isAddressInContacts(selectedAddress)}
        />
        {addContactData && (
          <AddContactDialog
            address={addContactData.address}
            network={addContactData.network}
            onClose={() => setAddContactData(null)}
          />
        )}
      </>
    );
  }

  // show compose
  if (showCompose) {
    return (
      <ComposeMessage
        onClose={() => {
          setShowCompose(false);
          setReplyTo(undefined);
        }}
        replyTo={replyTo}
      />
    );
  }

  return (
    <div className='flex flex-col h-full'>
      {/* header */}
      <div className='flex items-center justify-between px-4 py-3 border-b border-border/40'>
        <div className='flex items-center gap-2'>
          <h1 className='text-lg font-medium'>inbox</h1>
          {isPenumbraSyncing && (
            <span className='flex items-center gap-1 text-xs text-muted-foreground'>
              <ReloadIcon className='h-3 w-3 animate-spin' />
              syncing{syncProgress ? ` (${syncProgress.current})` : '...'}
            </span>
          )}
        </div>
        <div className='flex items-center gap-2'>
          <button
            onClick={() => syncPenumbraMemos()}
            disabled={isPenumbraSyncing}
            className='rounded-lg p-1.5 hover:bg-muted transition-colors disabled:opacity-50'
            title='sync messages'
          >
            <ReloadIcon className={cn('h-4 w-4', isPenumbraSyncing && 'animate-spin')} />
          </button>
          <button
            onClick={() => setShowCompose(true)}
            className='flex items-center gap-1 rounded-lg bg-zigner-gold px-3 py-1.5 text-sm font-medium text-zigner-dark'
          >
            <PaperPlaneIcon className='h-4 w-4' />
            compose
          </button>
        </div>
      </div>

      {/* tabs */}
      <div className='flex border-b border-border/40'>
        <button
          onClick={() => setTab('inbox')}
          className={cn(
            'flex-1 py-2.5 text-sm font-medium border-b-2 transition-colors',
            tab === 'inbox'
              ? 'border-zigner-gold text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          )}
        >
          inbox
          {unreadCount > 0 && (
            <span className='ml-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground'>
              {unreadCount}
            </span>
          )}
        </button>
        <button
          onClick={() => setTab('sent')}
          className={cn(
            'flex-1 py-2.5 text-sm font-medium border-b-2 transition-colors',
            tab === 'sent'
              ? 'border-zigner-gold text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          )}
        >
          sent
        </button>
      </div>

      {/* search */}
      <div className='px-4 py-3'>
        <div className='relative'>
          <MagnifyingGlassIcon className='absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground' />
          <input
            type='text'
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder='search messages...'
            className='w-full rounded-lg border border-border bg-input pl-9 pr-3 py-2 text-sm focus:border-zigner-gold focus:outline-none'
          />
        </div>
      </div>

      {/* mark all read */}
      {tab === 'inbox' && unreadCount > 0 && (
        <div className='px-4 pb-2'>
          <button
            onClick={() => void messages.markAllRead()}
            className='flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground'
          >
            <CheckIcon className='h-3 w-3' />
            mark all read
          </button>
        </div>
      )}

      {/* messages list */}
      <div className='flex-1 overflow-y-auto px-4 pb-4'>
        {displayedMessages.length === 0 ? (
          <div className='flex flex-col items-center justify-center gap-3 py-12 text-center'>
            <div className='rounded-full bg-primary/10 p-4'>
              <EnvelopeClosedIcon className='h-8 w-8 text-primary' />
            </div>
            <div>
              <p className='text-sm font-medium'>
                {tab === 'inbox' ? 'no messages' : 'no sent messages'}
              </p>
              <p className='text-xs text-muted-foreground'>
                {tab === 'inbox'
                  ? 'encrypted messages from zcash and penumbra will appear here'
                  : 'messages you send will appear here'}
              </p>
            </div>
          </div>
        ) : (
          <div className='space-y-2'>
            {displayedMessages.map((message) => {
              const address = message.direction === 'received'
                ? message.senderAddress
                : message.recipientAddress;
              return (
                <MessageRow
                  key={message.id}
                  message={message}
                  contactName={getContactName(address)}
                  onClick={() => handleSelectMessage(message)}
                  onMarkRead={() => void messages.markRead(message.id)}
                  onDelete={() => void messages.deleteMessage(message.id)}
                  onAddToContacts={address ? () => handleAddToContacts(address, message.network) : undefined}
                  isInContacts={isAddressInContacts(address)}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* add to contacts dialog */}
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

export default InboxPage;
