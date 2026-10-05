/**
 * a card someone gave you (Cv2Received, Cv2MemoSend, Cv2Invalid): opened from
 * a scanned QR or a `zafu.pro/c#` link. A v2 card is checked before anything
 * is shown as theirs; saving makes your own card for them and posts it into
 * the card's room, or, when the relay does not answer, sends it as a memo.
 *
 * A v1 card is not signed: its name and address are the sender's word, and
 * the screen says so.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { ZidSeal } from '@repo/ui/components/ui/zid-seal';
import { cn } from '@repo/ui/lib/utils';
import { bytesToHex } from '@noble/hashes/utils';
import { Cap, cardV2Memos, fromB64url, type CardV2 } from '@repo/wallet/networks/zcash/card-v2';
import type { ContactCard } from '@repo/wallet/networks/zcash/memo-codec';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo, selectGetMnemonic } from '../../../state/keyring';
import { findRelationship } from '../../../state/identity';
import { readCardLink } from '../../../state/contact-share';
import { getDiversifiedAddresses } from '../../../state/diversified-addresses';
import { peopleAsk, peopleCall, useMyRooms } from '../../../people/client';
import { addressesOf, givenOf, useMyCards } from '../../../people/my-card';
import { cardRoomId } from '../../../people/cards';
import { knownRelay } from '../../../people/use-invites';
import { useRelayAsk } from '../../../people/relay-ask';
import { DEFAULT_PEOPLE_RELAY, relayHost } from '../../../config/people-relay';
import { viaLine } from '../../../links/land';
import { ScreenHeader } from '../../../components/screen-header';
import { PopupPath, contactPath, threadPath } from '../paths';
import { shortAddress } from '../inbox/threads';

export type CardState =
  | { kind: 'unreadable' }
  | { kind: 'mine' }
  | { kind: 'saved'; contactId: string; name: string }
  | { kind: 'new'; card: ContactCard };

/** what a v1 card is to you: someone new, someone saved, your own, or not a card */
export const cardState = (
  card: ContactCard | undefined,
  saved: { id: string; name: string } | undefined,
  mine: boolean,
): CardState =>
  !card
    ? { kind: 'unreadable' }
    : mine
      ? { kind: 'mine' }
      : saved
        ? { kind: 'saved', contactId: saved.id, name: saved.name }
        : { kind: 'new', card };

/** what a v2 card offers, as words */
export const offers = (c: CardV2): string[] => [
  ...(c.caps & Cap.chat ? ['chat'] : []),
  ...(c.zcash ? ['zcash'] : []),
  ...(c.penumbra ? ['penumbra'] : []),
  ...(c.caps & Cap.deals ? ['deals'] : []),
  ...(c.caps & Cap.calls ? ['calls'] : []),
];

/** Cv2Invalid: what was wrong, and that nothing happened */
const Invalid = ({ why, next }: { why: string; next: string }) => {
  const navigate = useNavigate();
  return (
    <>
      <main className='flex grow flex-col gap-4 px-4 py-5'>
        <span className='i-lucide-shield-x size-8 text-hanko-light' aria-hidden='true' />
        <span className='font-display text-xl text-fg-high'>this card cannot be used</span>
        <span className='text-sm text-fg'>{why}</span>
        <div className='flex flex-col border border-border-soft bg-elev-1 text-xs text-fg-muted'>
          <span className='border-b border-border-soft px-3.5 py-2.5'>saved nothing</span>
          <span className='px-3.5 py-2.5'>sent nothing</span>
        </div>
        <span className='text-xs text-fg-muted'>{next}</span>
      </main>
      <footer className='flex shrink-0 gap-2 border-t border-border-soft px-4 pb-4 pt-3'>
        <Button
          variant='secondary'
          className='flex-1'
          onClick={() => navigate(PopupPath.INBOX_SCAN, { replace: true })}
        >
          scan again
        </Button>
        <Button
          variant='secondary'
          className='flex-1'
          onClick={() => navigate(PopupPath.INBOX, { replace: true })}
        >
          close
        </Button>
      </footer>
    </>
  );
};

const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className='flex h-11 items-center gap-3 border-b border-border-soft px-3.5 last:border-0'>
    <span className='w-20 shrink-0 text-xs text-fg-muted'>{label}</span>
    <span className='flex min-w-0 grow items-center gap-1.5 truncate text-xs text-fg-high'>
      {children}
    </span>
  </div>
);

/** Cv2Received, and Cv2MemoSend when the relay does not answer */
const Received = ({
  card,
  b64,
  via,
  onSaving,
}: {
  card: CardV2;
  b64: string;
  via: string | null;
  /** saving began here: this screen stays on until it is done */
  onSaving: () => void;
}) => {
  const navigate = useNavigate();
  const cards = useMyCards();
  const { addContact, removeContact } = useStore(s => s.contacts);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [down, setDown] = useState<{
    contactId: string;
    memo: string;
    rel: { gen: number; j: number };
    answer: string;
  }>();
  const [cancelled, setCancelled] = useState(false);
  const relayAsk = useRelayAsk();
  // a relay zafu does not know is named here, and asked about before saving
  const [known, setKnown] = useState<boolean>();
  useEffect(() => {
    void knownRelay(card.relay).then(setKnown, () => setKnown(false));
  }, [card.relay]);
  const theirName = card.name ?? '';
  const call = name.trim() || theirName;
  const zcash = addressesOf(card).find(a => a.network === 'zcash')?.address;

  // a card its maker cancelled says so, when the relay is already allowed
  useEffect(() => {
    void peopleCall<{ closed?: boolean }>('card-peek', { card: b64 }).then(
      r => r.closed && setCancelled(true),
      () => undefined,
    );
  }, [b64]);

  const post = async (contactId: string, rel: { gen: number; j: number }, answer: string) => {
    try {
      await peopleAsk('card-answer', { theirs: b64, answer, contactId, ...rel });
      navigate(zcash ? threadPath(zcash.toLowerCase()) : contactPath(contactId), { replace: true });
    } catch (e) {
      if (e instanceof Error && e.message === 'cancelled') {
        await removeContact(contactId);
        setCancelled(true);
        return;
      }
      setDown({
        contactId,
        rel,
        answer,
        memo: bytesToHex(cardV2Memos(fromB64url(answer))[0]!),
      });
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      if (!(await knownRelay(card.relay)) && !(await relayAsk.ask(card.relay))) {
        return;
      }
      onSaving();
      const rel = await cards.newRel();
      const contactId = crypto.randomUUID();
      const answer = await cards.answer(card, contactId, rel);
      await addContact({
        id: contactId,
        name: call || 'someone',
        zid: card.key,
        pairKa: card.pairKa,
        rel,
        addresses: addressesOf(card),
        cardV2: b64,
        source: via === 'scanned' ? 'scan' : 'link',
        given: givenOf(answer.card),
      });
      await post(contactId, rel, answer.b64);
    } finally {
      setBusy(false);
    }
  };

  if (cancelled) {
    return (
      <Invalid
        why='it was cancelled by the person who made it.'
        next='please ask them for a new card.'
      />
    );
  }

  return (
    <>
      <main className='flex grow flex-col gap-3.5 px-4 py-4'>
        <div className='flex items-center gap-4'>
          <ZidSeal hex={card.key} size={58} />
          <span className='flex min-w-0 flex-col gap-1'>
            <span className='truncate font-display text-[22px] text-fg-high'>
              {theirName || 'someone'}
            </span>
            <span className='text-[11px] text-fg-muted'>
              {theirName ? 'the name in their card' : 'their card has no name'}
            </span>
          </span>
        </div>
        <div className='flex flex-col border border-border-soft bg-elev-1'>
          <Fact label='came from'>{via === 'scanned' ? 'a qr' : 'a link'} · just now</Fact>
          <Fact label='signature'>
            <span
              className='i-lucide-check size-3.5 shrink-0 text-zigner-gold'
              aria-hidden='true'
            />
            unchanged since signed
          </Fact>
          {card.relay !== DEFAULT_PEOPLE_RELAY && (
            <Fact label='relay'>
              <span className={cn('truncate', known === false && 'text-warn')}>
                {relayHost(card.relay)}
                {known === false ? ' · new to zafu' : ''}
              </span>
            </Fact>
          )}
          <Fact label='seal'>check it when you meet</Fact>
        </div>
        <div className='flex flex-col gap-1.5'>
          <span className='text-[11px] text-fg-muted'>{theirName || 'they'} offer</span>
          <div className='flex flex-wrap gap-1.5'>
            {offers(card).map(o => (
              <span key={o} className='border border-border-soft px-2 py-1 text-[11px] text-fg'>
                {o}
              </span>
            ))}
          </div>
        </div>
        <Input
          aria-label='you call them'
          placeholder={theirName || 'you call them'}
          value={name}
          onChange={e => setName(e.target.value)}
        />
        {down ? (
          <div className='flex items-center justify-between gap-3 text-[11px]'>
            <span className='text-warn'>the relay is not answering</span>
            <button
              type='button'
              className='text-zigner-gold hover:underline'
              onClick={() => {
                setBusy(true);
                void post(down.contactId, down.rel, down.answer).finally(() => setBusy(false));
              }}
            >
              try again
            </button>
          </div>
        ) : (
          <span className='text-[11px] text-fg-muted'>
            saving sends {theirName || 'them'} your card
          </span>
        )}
      </main>
      <footer className='flex shrink-0 gap-2 border-t border-border-soft px-4 pb-4 pt-3'>
        {down ? (
          <Button
            className='flex-1'
            disabled={!zcash}
            onClick={() =>
              navigate(PopupPath.SEND, {
                state: { prefillRecipient: zcash, prefillMemo: down.memo, network: 'zcash' },
              })
            }
          >
            answer by memo · fee 0.0001 zec
          </Button>
        ) : (
          <>
            <Button
              variant='secondary'
              className='flex-1'
              onClick={() => navigate(PopupPath.INBOX, { replace: true })}
            >
              not now
            </Button>
            <Button
              className='flex-1'
              disabled={busy || !call || !cards.ready}
              onClick={() => void save()}
            >
              save
            </Button>
          </>
        )}
      </footer>
      {relayAsk.sheet}
    </>
  );
};

/** a v1 card: unsigned, so everything in it is the sender's word */
const V1 = ({ card, via }: { card: ContactCard; via: string | null }) => {
  const navigate = useNavigate();
  const saved = useStore(s => s.contacts.findByAddress(card.address)?.contact);
  const addContact = useStore(s => s.contacts.addContact);
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const getMnemonic = useStore(selectGetMnemonic);
  const [mine, setMine] = useState<boolean>();
  const [name, setName] = useState(card.name);
  useEffect(() => {
    void getDiversifiedAddresses().then(
      rs => setMine(rs.some(r => r.address.trim().toLowerCase() === card.address.toLowerCase())),
      () => setMine(false),
    );
  }, [card]);
  const state = cardState(card, saved, mine === true);

  const save = async () => {
    // a v1 card answering one you gave names its relationship
    const rel =
      card.answers && keyInfo?.type === 'mnemonic'
        ? await findRelationship(await getMnemonic(keyInfo.id), keyInfo.id, card.answers)
        : undefined;
    const contact = await addContact({
      name: name.trim(),
      zid: card.zid,
      pairKa: card.pairKa,
      ...(rel && keyInfo ? { rel: { walletId: keyInfo.id, ...rel } } : {}),
      addresses: [{ network: 'zcash', address: card.address }],
    });
    if (rel) {
      await peopleCall('pair-join', { contactId: contact.id }).catch(() => undefined);
    }
    navigate(contactPath(contact.id), { replace: true });
  };

  if (mine === undefined) {
    return null;
  }
  if (state.kind === 'mine') {
    return <Invalid why='this is your own card.' next='please show it to the other person.' />;
  }
  if (state.kind === 'saved') {
    return (
      <main className='flex flex-col gap-4 px-4 py-6'>
        <p className='text-sm text-fg'>{state.name} is already in your people</p>
        <Button
          variant='secondary'
          onClick={() => navigate(contactPath(state.contactId), { replace: true })}
        >
          open
        </Button>
      </main>
    );
  }
  return (
    <main className='flex flex-col gap-4 px-4 py-[18px]'>
      <div className='flex items-center gap-4'>
        <ZidSeal hex={card.zid} size={58} />
        <span className='flex min-w-0 flex-col gap-1'>
          <span className='truncate font-display text-[22px] text-fg-high'>
            {card.name || 'someone'}
          </span>
          <span className='text-[11px] text-fg-muted'>an older card · not signed</span>
        </span>
      </div>
      <div className='flex h-[50px] items-center gap-3 border border-border-soft bg-elev-1 px-3.5'>
        <span className='grow text-sm text-fg-high'>zcash</span>
        <span className='text-xs text-fg-muted'>{shortAddress(card.address)}</span>
      </div>
      <Input
        aria-label='name'
        placeholder='what do you call them?'
        value={name}
        onChange={e => setName(e.target.value)}
      />
      <Button disabled={!name.trim()} onClick={() => void save()}>
        save
      </Button>
      {via && <span className='text-[11px] text-fg-muted'>{viaLine(via)}</span>}
    </main>
  );
};

export function CardPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const read = useMemo(() => readCardLink(params.get('card') ?? ''), [params]);
  const via = params.get('via');
  const rooms = useMyRooms();
  const saved = useStore(s =>
    read?.v === 2 && read.card
      ? (Array.isArray(s.contacts.contacts) ? s.contacts.contacts : []).find(
          c => c.zid === read.card!.key,
        )
      : undefined,
  );
  const v2 = read?.v === 2 ? read : undefined;
  // saved on this screen: it carries on (relay, or the memo) instead of "already saved"
  const [savingHere, setSavingHere] = useState(false);
  const mine = !!v2?.card && rooms.some(r => r.id === cardRoomId(v2.card!.key) && r.card?.mine);

  return (
    <div className={cn('flex min-h-full flex-col')}>
      <ScreenHeader
        title={v2?.card?.name ? `add ${v2.card.name}` : 'add a person'}
        backPath={PopupPath.INBOX_SCAN}
      />
      {!read ? (
        <Invalid why='this is not a zafu card.' next='please ask them for their card link.' />
      ) : read.v === 1 ? (
        <V1 card={read.card} via={via} />
      ) : !read.card ? (
        <Invalid
          why='it does not read: something in it changed after it was signed, or it names a relay zafu does not use.'
          next='please ask them for a new card, in person if you can.'
        />
      ) : mine ? (
        <Invalid why='this is your own card.' next='please show it to the other person.' />
      ) : saved && !savingHere ? (
        <main className='flex flex-col gap-4 px-4 py-6'>
          <p className='text-sm text-fg'>{saved.name} is already in your people</p>
          <Button
            variant='secondary'
            onClick={() => navigate(contactPath(saved.id), { replace: true })}
          >
            open
          </Button>
        </main>
      ) : (
        <Received card={read.card} b64={read.b64} via={via} onSaving={() => setSavingHere(true)} />
      )}
    </div>
  );
}

export default CardPage;
