/**
 * one direct thread (Thread.dc.html): everything between you and one
 * address, oldest first, with a `zcash:` request shown as a pay card and a
 * payment as one quiet line.
 *
 * Two transports (design-social 2.7, 4.7). With someone whose card you hold
 * and who holds yours, text goes over your pair room on the people relay:
 * free and instant, a hairline bubble. Everyone else, and money always, goes
 * as a memo in a shielded transaction: a gold rule. The square left of the
 * field is the transport; one tap sends the next message as a memo instead.
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
import { isMutual } from '../../../state/contacts';
import { peopleCall, peopleSay, useMyRooms, useThread, useWatchRoom } from '../../../people/client';
import { RelaySlot } from '../../../people/relay-slot';
import { pairId } from '../../../people/protocol';
import type { PairCard, ThreadItem } from '../../../people/vault';
import {
  allowRelay,
  useChooseAnswer,
  useMemoInvite,
  usePairCards,
} from '../../../people/use-invites';
import {
  DEFAULT_PEOPLE_RELAY,
  PEOPLE_RELAY_KEY,
  defaultPeopleRelay,
  peopleRelays,
  relayBase,
  relayHost,
  type PeopleRelaySetting,
} from '../../../config/people-relay';
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
            'border-l-2 border-l-zigner-gold',
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

/** a line on the pair room: a hairline, no fill */
const RelayLine = ({ item, onRetry }: { item: ThreadItem; onRetry: () => void }) => (
  <>
    <div
      className={cn(
        'max-w-[78%] border border-border-hard px-3 py-[9px] text-[13px] leading-normal text-fg-high',
        item.mine ? 'self-end' : 'self-start',
      )}
    >
      <p className='whitespace-pre-wrap break-words'>
        <MessageText text={item.body} />
      </p>
    </div>
    {item.mine && (
      <span
        className={cn(
          'self-end text-[11px]',
          item.status === 'failed' ? 'text-hanko-light' : 'text-fg-muted',
        )}
      >
        {item.status === 'sending' ? (
          'sending'
        ) : item.status === 'failed' ? (
          <>
            this did not reach the relay ·{' '}
            <button type='button' onClick={onRetry} className='text-zigner-gold hover:underline'>
              try again
            </button>
          </>
        ) : (
          'on the relay'
        )}
      </span>
    )}
  </>
);

/** the ZIP 317 floor for a shielded memo: two actions at 5000 zat */
const MEMO_FEE = '0.0001';

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

/** which relay your chats with this person go through: one you know, or a new one you allow */
const RelaySheet = ({
  open,
  onClose,
  current,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  current: string;
  onPick: (relay: string) => void;
}) => {
  const [known, setKnown] = useState<string[]>([]);
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (open) {
      void chrome.storage.local
        .get(PEOPLE_RELAY_KEY)
        .then(v => setKnown(peopleRelays(v[PEOPLE_RELAY_KEY] as PeopleRelaySetting | undefined)));
    }
  }, [open]);
  const pick = (relay: string) => {
    onPick(relay === known[0] ? '' : relay);
    onClose();
  };
  return (
    <Sheet open={open} onOpenChange={o => !o && onClose()} title='which relay'>
      <div className='flex flex-col border border-border-soft bg-elev-1'>
        {known.map(r => (
          <button
            key={r}
            type='button'
            onClick={() => pick(r)}
            className='flex h-12 items-center justify-between border-b border-border-soft px-3.5 text-left text-sm text-fg-high last:border-0 hover:bg-elev-2'
          >
            {relayHost(r)}
            {r === current && <span className='i-lucide-check size-4 text-zigner-gold' />}
          </button>
        ))}
      </div>
      <form
        className='flex gap-2'
        onSubmit={e => {
          e.preventDefault();
          const base = relayBase(typed);
          if (base) {
            void allowRelay(base).then(ok => ok && pick(base));
          }
        }}
      >
        <Input
          aria-label='another relay'
          placeholder='https://relay.example'
          value={typed}
          onChange={e => setTyped(e.target.value)}
          className='grow font-mono text-xs'
        />
        <Button type='submit' variant='secondary' disabled={!relayBase(typed)}>
          allow
        </Button>
      </form>
    </Sheet>
  );
};

/** the people relay new rooms use, as the person set it */
const useDefaultRelay = (): string => {
  const [relay, setRelay] = useState(DEFAULT_PEOPLE_RELAY);
  useEffect(() => {
    void chrome.storage.local
      .get(PEOPLE_RELAY_KEY)
      .then(v =>
        setRelay(defaultPeopleRelay(v[PEOPLE_RELAY_KEY] as PeopleRelaySetting | undefined)),
      );
  }, []);
  return relay;
};

/**
 * Answers to your memo invite, waiting for you: anyone who can read that memo
 * could have answered, so the seal is shown and you say which one is them.
 * Two different answers are both shown; zafu never picks.
 */
const Answers = ({ contactId, answers }: { contactId: string; answers: PairCard[] }) => {
  const choose = useChooseAnswer();
  const [busy, setBusy] = useState(false);
  return (
    <div className='flex shrink-0 flex-col gap-2 border-t border-border-soft px-4 py-3'>
      <span className='text-[11px] text-fg-muted'>
        {answers.length > 1
          ? 'two different answers came back. please check the seal with them before you choose.'
          : 'your invite was answered. please check the seal with them.'}
      </span>
      {answers.map(a => (
        <div key={a.zid} className='flex items-center gap-3'>
          <ZidSeal hex={a.zid} size={32} />
          <span className='grow truncate text-xs text-fg'>{a.name || shortAddress(a.address)}</span>
          <button
            type='button'
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void choose(contactId, a).finally(() => setBusy(false));
            }}
            className='shrink-0 text-xs text-zigner-gold hover:underline'
          >
            this is them
          </button>
        </div>
      ))}
    </div>
  );
};

export function ThreadPage() {
  const navigate = useNavigate();
  const goBack = useBackNav(PopupPath.INBOX);
  const threadId = decodeURIComponent(useParams()['threadId'] ?? '');
  const all = useStore(s => s.messages.messages);
  const markRead = useStore(s => s.messages.markRead);
  const updateContact = useStore(s => s.contacts.updateContact);
  const defaultRelay = useDefaultRelay();
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

  // the pair room, when you hold each other's cards
  const mutual = network === 'zcash' && isMutual(contact, keyInfo?.id);
  const roomId = mutual && contact ? pairId(contact.id) : undefined;
  const myRooms = useMyRooms();
  const room = myRooms.find(r => r.id === roomId && r.joined);
  const relay = useThread(room)?.items;
  // your invite to someone with no card from you, waiting for their answer
  const waiting = myRooms.some(r => contact && r.id === pairId(contact.id) && r.pair?.waiting);
  // answers to that invite you have not confirmed: anyone who reads the memo can answer
  const answers = myRooms.find(r => contact && r.id === pairId(contact.id))?.pair?.answers ?? [];
  const [asMemo, setAsMemo] = useState(false);
  const via: 'relay' | 'memo' = room && !asMemo ? 'relay' : 'memo';
  // the pair room, or the one waiting for an answer to your invite: read while on screen (T2)
  useWatchRoom(room?.id ?? (waiting && contact ? pairId(contact.id) : undefined));
  useEffect(() => {
    if (roomId && !room && contact) {
      void peopleCall('pair-join', { contactId: contact.id }).catch(() => undefined);
    }
  }, [roomId, room, contact]);

  // the memo door (people/memo-door): someone saved, with no card from you yet
  const memoInvite = useMemoInvite();
  const invites =
    !!contact &&
    !mutual &&
    network === 'zcash' &&
    keyInfo?.type === 'mnemonic' &&
    !waiting &&
    answers.length === 0;
  const [picking, setPicking] = useState(false);
  usePairCards();

  const rows = useMemo(
    () =>
      [
        ...messages.map(m => ({ key: m.id, t: m.timestamp, m })),
        ...(relay ?? []).map(it => ({ key: it.hash || it.local!, t: it.ts * 1000, it })),
      ].sort((a, b) => a.t - b.t),
    [messages, relay],
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    for (const m of messages) {
      if (m.direction === 'received' && !m.read) {
        void markRead(m.id);
      }
    }
  }, [messages, markRead, rows.length]);
  useEffect(() => {
    if (room && relay?.some(i => !i.mine)) {
      void peopleCall('read', { roomId: room.id }).catch(() => undefined);
    }
  }, [room, relay]);

  const say = (text: string, retry?: string) =>
    room && void peopleSay(room.id, text, retry).catch(() => undefined);

  const send = (prefillMemo?: string) =>
    navigate(PopupPath.SEND, { state: { prefillRecipient: address, prefillMemo, network } });

  const sendText = async () => {
    const text = draft.trim();
    if (!text) {
      return;
    }
    if (via === 'relay') {
      setDraft('');
      say(text);
      return;
    }
    setAsMemo(false);
    // the first memo to someone with no card from you invites them to chat
    if (invites && contact) {
      const memo = await memoInvite(contact, text).catch(() => undefined);
      if (memo) {
        send(memo);
        return;
      }
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

      {room && <RelaySlot />}
      <div ref={scrollRef} className='flex grow flex-col gap-3 overflow-y-auto px-3.5 pb-2 pt-3.5'>
        {rows.map((r, i) => (
          <div key={r.key} className='contents'>
            {dayOf(r.t) !== dayOf(rows[i - 1]?.t ?? 0) && (
              <span className='self-center text-[11px] text-fg-dim'>{dayOf(r.t)}</span>
            )}
            {'m' in r ? (
              <Item m={r.m} from={name} />
            ) : (
              <RelayLine item={r.it} onRetry={() => say(r.it.body, r.it.local)} />
            )}
          </div>
        ))}
      </div>

      {contact && answers.length > 0 && <Answers contactId={contact.id} answers={answers} />}
      {canSend && (invites || waiting) && (
        <div className='flex h-8 shrink-0 items-center justify-between gap-3 border-t border-border-soft px-4 text-[11px] text-fg-muted'>
          <span className='truncate'>
            {waiting
              ? `waiting for ${name} to answer your invite`
              : `invites ${name} to chat · on ${relayHost(contact?.relay || defaultRelay)}`}
          </span>
          {invites && (
            <button
              type='button'
              onClick={() => setPicking(true)}
              className='shrink-0 text-zigner-gold hover:underline'
            >
              change
            </button>
          )}
        </div>
      )}
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
          <button
            type='button'
            aria-label={via === 'relay' ? 'relay · tap to send as a memo' : 'memo'}
            aria-pressed={via === 'memo'}
            disabled={!room}
            onClick={() => setAsMemo(v => !v)}
            className='grid size-11 shrink-0 place-items-center border border-border-soft disabled:cursor-default'
          >
            <span
              className={cn(
                'size-3.5',
                via === 'relay' ? 'border border-fg-muted' : 'bg-zigner-gold',
              )}
              aria-hidden='true'
            />
          </button>
          <Input
            aria-label='message'
            placeholder={`message ${name}`}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            className='h-11 min-w-0 grow'
          />
          <button
            type='submit'
            disabled={!draft.trim()}
            className='h-11 shrink-0 bg-zigner-gold px-3 text-xs text-zigner-gold-foreground hover:bg-zigner-gold-light disabled:bg-elev-2 disabled:text-fg-dim'
          >
            {via === 'memo' && network === 'zcash' ? `send · ${MEMO_FEE}` : 'send'}
          </button>
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
      {contact && (
        <RelaySheet
          open={picking}
          onClose={() => setPicking(false)}
          current={contact.relay || defaultRelay}
          onPick={relay => void updateContact(contact.id, { relay })}
        />
      )}
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
