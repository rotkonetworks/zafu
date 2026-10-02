/**
 * one direct thread (Thread.dc.html): everything between you and one
 * address, oldest first, with a `zcash:` request shown as a pay card and a
 * payment as one quiet line. The composer hands text, a payment or a request
 * to the send pipeline with the recipient filled in; the memo is the only
 * transport there is today, so every message is a shielded transaction.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { ZidSeal } from '@repo/ui/components/ui/zid-seal';
import { cn } from '@repo/ui/lib/utils';
import {
  buildZip321,
  formatZecAmount,
  parseZecAmount,
  parseZip321,
} from '@repo/wallet/networks/zcash/zip321';
import { useStore } from '../../../state';
import type { Message, MessageStatus } from '../../../state/messages';
import { selectEffectiveKeyInfo } from '../../../state/keyring';
import { keyInfoSupportsNetwork } from '../../../state/keyring/vault-ops';
import { replyAddress } from '../../../state/contact-share';
import { useContactAddressSource } from '../../../hooks/use-contact-address-source';
import { useActiveAddress } from '../../../hooks/use-address';
import { useBackNav } from '../../../utils/navigate';
import { MessageText } from '../../../components/message-text';
import { PopupPath, contactPath } from '../paths';
import { useThreadName } from './use-thread-name';
import { cardOf, counterparty, shortAddress, threadIdOf, whenOf } from './threads';

const ZCASH_LINK = /zcash:[^\s]+/i;

const dayOf = (ts: number) => {
  const w = whenOf(ts);
  return /^\d/.test(w) ? 'today' : w;
};

/** what a payment's own line says while it travels (spec 4.3) */
const STATUS: Record<MessageStatus, string> = {
  submitting: 'proving',
  broadcasting: 'sent',
  pending: 'waiting for a block',
  confirmed: '',
  failed: 'this did not leave. please try again.',
  interrupted: 'zafu closed before we saw it leave. it may still arrive.',
};

const PayCard = ({ uri, mine, from }: { uri: string; mine: boolean; from: string }) => {
  const navigate = useNavigate();
  const parsed = parseZip321(uri);
  const p = parsed.ok ? parsed.payments[0] : undefined;
  if (!p) {
    return null;
  }
  return (
    <article className='flex w-[78%] flex-col self-start border border-border-hard bg-elev-1'>
      <div className='flex flex-col gap-1 px-3.5 py-3'>
        <span className='text-[11px] text-fg-muted'>
          {mine ? 'you asked for' : `${from} requests`}
        </span>
        <span className='font-display text-[26px] text-fg-high'>
          {p.amountZat !== undefined ? formatZecAmount(p.amountZat) : 'any amount'}{' '}
          <span className='text-sm text-zigner-gold'>zec</span>
        </span>
        {(p.message ?? p.label) && (
          <span className='text-xs text-fg-muted'>{p.message ?? p.label}</span>
        )}
      </div>
      {!mine && (
        <button
          type='button'
          onClick={() => navigate(`${PopupPath.LINK}?uri=${encodeURIComponent(uri)}`)}
          className='h-10 bg-zigner-gold text-[13px] text-zigner-gold-foreground hover:bg-zigner-gold-light'
        >
          pay
        </button>
      )}
    </article>
  );
};

const CardItem = ({ m }: { m: Message }) => {
  const card = cardOf(m);
  const saved = useStore(s => (card ? !!s.contacts.findByAddress(card.address) : false));
  const { addContact, addAddress } = useStore(s => s.contacts);
  if (!card) {
    return null;
  }
  return (
    <article className='flex w-[78%] flex-col gap-1.5 self-start border border-border-hard bg-elev-1 px-3.5 py-3'>
      <span className='text-[11px] text-fg-muted'>a card · not checked yet</span>
      <span className='text-sm text-fg-high'>{card.name || 'someone'}</span>
      <span className='font-mono text-[11px] text-fg-muted'>{shortAddress(card.address)}</span>
      {saved ? (
        <span className='text-[11px] text-fg-muted'>in your contacts</span>
      ) : (
        <Button
          variant='secondary'
          size='sm'
          className='self-start'
          onClick={() =>
            void addContact({ name: card.name || 'someone' }).then(c =>
              addAddress(c.id, { network: 'zcash', address: card.address }),
            )
          }
        >
          save
        </Button>
      )}
    </article>
  );
};

const Item = ({ m, from }: { m: Message; from: string }) => {
  const mine = m.direction === 'sent';
  if (m.asset === 'contact-card') {
    return <CardItem m={m} />;
  }
  const link = ZCASH_LINK.exec(m.content)?.[0];
  const text = (link ? m.content.replace(link, '') : m.content).trim();
  const status = m.status ? STATUS[m.status] : '';
  // a memo whose block time could not be read shows its block, never a made-up date
  const when =
    whenOf(m.timestamp) || (m.blockHeight ? `block ${m.blockHeight.toLocaleString('en')}` : '');
  return (
    <>
      {text && (
        <div
          className={cn(
            'max-w-[78%] border px-3 py-[9px] text-[13px] leading-normal text-fg-high',
            mine
              ? 'self-end border-gold-line bg-zigner-gold/10'
              : 'self-start border-border-soft bg-elev-1',
          )}
        >
          <p className='whitespace-pre-wrap break-words'>
            <MessageText text={text} />
          </p>
        </div>
      )}
      {link && <PayCard uri={link} mine={mine} from={from} />}
      {m.amount && (
        <div className='flex items-center gap-1.5 self-center text-[11px] text-fg-muted'>
          <span className={cn('size-1.5', status ? 'border border-fg-muted' : 'bg-success')} />
          {mine ? 'you paid' : 'received'} {m.amount}{' '}
          {m.network === 'zcash' ? 'zec' : (m.asset ?? '')}
          {when && ` · ${when}`}
        </div>
      )}
      {status && (
        <span
          className={cn(
            'text-[11px]',
            mine ? 'self-end' : 'self-start',
            m.status === 'failed' ? 'text-hanko-light' : 'text-fg-muted',
          )}
        >
          {status}
        </span>
      )}
    </>
  );
};

/** + in the composer: pay them, or ask them for an amount */
const MoneySheet = ({
  open,
  onClose,
  onPay,
  onRequest,
}: {
  open: boolean;
  onClose: () => void;
  onPay: () => void;
  onRequest?: (zat: bigint, note: string) => void;
}) => {
  const [asking, setAsking] = useState(false);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const zat = parseZecAmount(amount);
  return (
    <Sheet
      open={open}
      onOpenChange={o => {
        if (!o) {
          setAsking(false);
          onClose();
        }
      }}
      title={asking ? 'request' : 'send or request'}
    >
      {asking && onRequest ? (
        <form
          className='flex flex-col gap-3'
          onSubmit={e => {
            e.preventDefault();
            if (zat) {
              onRequest(zat, note.trim());
            }
          }}
        >
          <Input
            aria-label='amount'
            inputMode='decimal'
            placeholder='amount in zec'
            value={amount}
            onChange={e => setAmount(e.target.value)}
            className='font-display text-xl'
          />
          <Input
            aria-label='what for'
            placeholder='what for (optional)'
            value={note}
            onChange={e => setNote(e.target.value)}
          />
          <Button type='submit' disabled={!zat}>
            ask for it
          </Button>
        </form>
      ) : (
        <div className='flex gap-2'>
          <Button className='flex-1' onClick={onPay}>
            pay
          </Button>
          {onRequest && (
            <Button variant='secondary' className='flex-1' onClick={() => setAsking(true)}>
              request
            </Button>
          )}
        </div>
      )}
    </Sheet>
  );
};

/** a thread with someone you have not saved: save them, from the title */
const SaveSheet = ({
  address,
  network,
  open,
  onClose,
}: {
  address: string;
  network: Message['network'];
  open: boolean;
  onClose: () => void;
}) => {
  const navigate = useNavigate();
  const { addContact, addAddress } = useStore(s => s.contacts);
  const [name, setName] = useState('');
  return (
    <Sheet open={open} onOpenChange={o => !o && onClose()} title='save this person'>
      <form
        className='flex flex-col gap-3'
        onSubmit={e => {
          e.preventDefault();
          void addContact({ name: name.trim() }).then(async c => {
            await addAddress(c.id, { network, address });
            onClose();
            navigate(contactPath(c.id));
          });
        }}
      >
        <Input
          aria-label='name'
          placeholder='what do you call them?'
          value={name}
          onChange={e => setName(e.target.value)}
          autoFocus
        />
        <span className='break-all font-mono text-[11px] text-fg-muted'>{address}</span>
        <Button type='submit' disabled={!name.trim()}>
          save
        </Button>
      </form>
    </Sheet>
  );
};

export function ThreadPage() {
  const navigate = useNavigate();
  const goBack = useBackNav(PopupPath.INBOX);
  const threadId = decodeURIComponent(useParams()['threadId'] ?? '');
  const all = useStore(s => s.messages.messages);
  const markRead = useStore(s => s.messages.markRead);
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const addressSource = useContactAddressSource();
  const { address: ownAddress } = useActiveAddress();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');
  const [money, setMoney] = useState(false);
  const [saving, setSaving] = useState(false);

  const messages = useMemo(
    () =>
      (Array.isArray(all) ? all : [])
        .filter(m => threadIdOf(m) === threadId)
        .sort((a, b) => a.timestamp - b.timestamp),
    [all, threadId],
  );
  const address = threadId.startsWith('s:')
    ? undefined
    : (messages.map(counterparty).find(Boolean) ?? threadId);
  const network: Message['network'] =
    messages[0]?.network ?? (address?.startsWith('penumbra') ? 'penumbra' : 'zcash');
  const contact = useStore(s => (address ? s.contacts.findByAddress(address)?.contact : undefined));
  const name = useThreadName(address);
  const canSend = !!address && !!keyInfo && keyInfoSupportsNetwork(keyInfo, network);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    for (const m of messages) {
      if (m.direction === 'received' && !m.read) {
        void markRead(m.id);
      }
    }
  }, [messages, markRead]);

  const send = (prefillMemo?: string) =>
    navigate(PopupPath.SEND, { state: { prefillRecipient: address, prefillMemo, network } });

  const sendText = async () => {
    const text = draft.trim();
    if (!text) {
      return;
    }
    const reply =
      network === 'zcash'
        ? await replyAddress(contact?.id, addressSource(), ownAddress)
        : undefined;
    send(reply ? `${text}\nreply:${reply}` : text);
  };

  const request = async (zat: bigint, note: string) => {
    const mine = await replyAddress(contact?.id, addressSource(), ownAddress);
    if (mine) {
      send(buildZip321({ address: mine, amountZat: zat, message: note || undefined }));
    }
  };

  return (
    <div className='flex h-full flex-col'>
      <header className='flex h-[60px] shrink-0 items-center gap-2 border-b border-border-soft px-2'>
        <button
          type='button'
          aria-label='back'
          onClick={goBack}
          className='grid h-10 w-9 shrink-0 place-items-center text-fg-muted hover:text-fg-high'
        >
          <span className='i-lucide-chevron-left size-[18px]' />
        </button>
        <ZidSeal hex={contact?.zid} size={26} />
        <button
          type='button'
          disabled={!address}
          onClick={() => (contact ? navigate(contactPath(contact.id)) : setSaving(true))}
          className='flex min-w-0 grow flex-col gap-[3px] pl-1 text-left'
        >
          <span className='truncate text-[15px] text-fg-high'>{name}</span>
          <span className='truncate text-[11px] text-fg-muted'>
            {contact
              ? contact.zid
                ? 'from a card'
                : 'address only'
              : address
                ? 'tap to save'
                : 'left no address'}
          </span>
        </button>
      </header>

      <div ref={scrollRef} className='flex grow flex-col gap-3 overflow-y-auto px-3.5 pb-2 pt-3.5'>
        {messages.map((m, i) => (
          <div key={m.id} className='contents'>
            {dayOf(m.timestamp) !== dayOf(messages[i - 1]?.timestamp ?? 0) && (
              <span className='self-center text-[11px] text-fg-dim'>{dayOf(m.timestamp)}</span>
            )}
            <Item m={m} from={name} />
          </div>
        ))}
      </div>

      {canSend ? (
        <form
          className='flex shrink-0 gap-2 border-t border-border-soft px-3 pb-3 pt-2.5'
          onSubmit={e => {
            e.preventDefault();
            void sendText();
          }}
        >
          <button
            type='button'
            aria-label='send or request zec'
            onClick={() => setMoney(true)}
            className='grid size-11 shrink-0 place-items-center border border-border-soft bg-elev-2 text-zigner-gold hover:bg-border-soft'
          >
            <span className='i-lucide-plus size-[18px]' aria-hidden='true' />
          </button>
          <Input
            aria-label='message'
            placeholder={`message ${name}`}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            className='h-11 min-w-0 grow'
          />
        </form>
      ) : (
        <p className='shrink-0 border-t border-border-soft px-4 py-3 text-[11px] text-fg-muted'>
          {address ? 'this wallet cannot send on this network' : 'they left no address to answer'}
        </p>
      )}

      <MoneySheet
        open={money}
        onClose={() => setMoney(false)}
        onPay={() => send()}
        onRequest={network === 'zcash' ? (zat, note) => void request(zat, note) : undefined}
      />
      {address && (
        <SaveSheet
          address={address}
          network={network}
          open={saving}
          onClose={() => setSaving(false)}
        />
      )}
    </div>
  );
}

export default ThreadPage;
