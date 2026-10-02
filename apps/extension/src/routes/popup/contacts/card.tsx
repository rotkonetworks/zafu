/**
 * a card someone gave you (spec 5.6): opened from a scanned QR, a clicked or
 * pasted `zafu:contact#…` / `zafu.pro/c#…` link. Review it, save them under
 * the name you choose, then show them your card for them, so two people add
 * each other with no network at all.
 *
 * A v1 card is not signed: its seal, name and address are the sender's word.
 * The screen says "not checked yet" and never more; comparing seals in person
 * is the check.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { ZidSeal } from '@repo/ui/components/ui/zid-seal';
import type { ContactCard } from '@repo/wallet/networks/zcash/memo-codec';
import { useStore } from '../../../state';
import { cardLinkPayload, readCardPayload } from '../../../state/contact-share';
import { getDiversifiedAddresses } from '../../../state/diversified-addresses';
import { useMintCard } from '../../../hooks/use-share-card';
import { viaLine } from '../../../links/land';
import { toUri } from '../../../links/router';
import { QrCode } from '../../../components/qr-code';
import { ScreenHeader } from '../../../components/screen-header';
import { PopupPath, contactPath } from '../paths';
import { shortAddress } from '../inbox/threads';

export type CardState =
  | { kind: 'unreadable' }
  | { kind: 'mine' }
  | { kind: 'saved'; contactId: string; name: string }
  | { kind: 'new'; card: ContactCard };

/** what this card is to you: someone new, someone saved, your own, or not a card */
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

const Line = ({
  text,
  action,
  onAction,
}: {
  text: string;
  action: string;
  onAction: () => void;
}) => (
  <div className='flex flex-col gap-4 px-4 py-6'>
    <p className='text-sm text-fg'>{text}</p>
    <Button variant='secondary' onClick={onAction}>
      {action}
    </Button>
  </div>
);

/** after saving them: your card for them, to scan off this screen */
const ShowYours = ({ contactId, name }: { contactId: string; name: string }) => {
  const navigate = useNavigate();
  const mint = useMintCard();
  const [link, setLink] = useState<string | null>();
  useEffect(() => {
    if (!mint) {
      return;
    }
    let live = true;
    void mint(contactId).then(
      hex => live && setLink(hex ? toUri({ kind: 'contact', card: cardLinkPayload(hex) }) : null),
      () => live && setLink(null),
    );
    return () => {
      live = false;
    };
  }, [mint, contactId]);

  return (
    <div className='flex flex-col items-center gap-4 px-4 py-5'>
      {mint && (
        <>
          <span className='self-start font-display text-xl text-fg-high'>
            show {name} your card
          </span>
          {link ? (
            <QrCode value={link} size={220} label='your card' />
          ) : (
            <span
              className='size-[220px] border border-dashed border-border-hard'
              aria-hidden='true'
            />
          )}
          <span className='text-xs text-fg-muted'>
            {link === null
              ? 'sorry, zafu could not make your card. please unlock and try again.'
              : link
                ? `when ${name} scans this, you are in each other's people`
                : 'preparing your card'}
          </span>
        </>
      )}
      <Button
        className='w-full'
        onClick={() => navigate(contactPath(contactId), { replace: true })}
      >
        done
      </Button>
    </div>
  );
};

export function CardPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const card = useMemo(() => readCardPayload(params.get('card') ?? ''), [params]);
  const via = viaLine(params.get('via'));
  const saved = useStore(s => (card ? s.contacts.findByAddress(card.address)?.contact : undefined));
  const { addContact, addAddress } = useStore(s => s.contacts);
  const [mine, setMine] = useState<boolean>();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState(card?.name ?? '');
  const [done, setDone] = useState<{ id: string; name: string }>();

  // every card you showed or sent is recorded with its address
  useEffect(() => {
    if (!card) {
      return setMine(false);
    }
    void getDiversifiedAddresses().then(
      rs => setMine(rs.some(r => r.address.trim().toLowerCase() === card.address.toLowerCase())),
      () => setMine(false),
    );
  }, [card]);

  const save = async () => {
    if (!card) {
      return;
    }
    const contact = await addContact({ name: name.trim(), zid: card.zid });
    await addAddress(contact.id, { network: 'zcash', address: card.address });
    setNaming(false);
    setDone({ id: contact.id, name: contact.name });
  };

  const state = cardState(card, saved, mine === true);
  const close = () => navigate(PopupPath.CONTACTS, { replace: true });

  return (
    <div className='flex min-h-full flex-col'>
      <ScreenHeader title={done ? done.name : 'a card'} backPath={PopupPath.CONTACTS} />
      {done ? (
        <ShowYours contactId={done.id} name={done.name} />
      ) : mine === undefined ? null : state.kind === 'unreadable' ? (
        <Line text='this is not a zafu card' action='close' onAction={close} />
      ) : state.kind === 'mine' ? (
        <Line text='this is your own card' action='close' onAction={close} />
      ) : state.kind === 'saved' ? (
        <Line
          text={`${state.name} is already in your people`}
          action='open'
          onAction={() => navigate(contactPath(state.contactId), { replace: true })}
        />
      ) : (
        <div className='flex flex-col gap-4 px-4 py-[18px]'>
          <div className='flex items-center gap-4'>
            <ZidSeal hex={state.card.zid} size={66} />
            <span className='flex min-w-0 flex-col gap-1'>
              <span className='truncate font-display text-[22px] text-fg-high'>
                {state.card.name || 'someone'}
              </span>
              <span className='text-[11px] text-fg-muted'>a card · not checked yet</span>
            </span>
          </div>
          <div className='flex h-[50px] items-center gap-3 border border-border-soft bg-elev-1 px-3.5'>
            <span className='grow text-sm text-fg-high'>zcash</span>
            <span className='text-xs text-fg-muted'>{shortAddress(state.card.address)}</span>
          </div>
          {state.card.zid && (
            <span className='text-[11px] text-fg-dim'>
              when you meet, this seal should match the one on their screen
            </span>
          )}
          <Button onClick={() => setNaming(true)}>save</Button>
          {via && <span className='text-[11px] text-fg-muted'>{via}</span>}
        </div>
      )}

      <Sheet open={naming} onOpenChange={setNaming} title='save this person'>
        <form
          className='flex flex-col gap-3'
          onSubmit={e => {
            e.preventDefault();
            void save();
          }}
        >
          <Input
            aria-label='name'
            placeholder='what do you call them?'
            value={name}
            onChange={e => setName(e.target.value)}
            autoFocus
          />
          <Button type='submit' disabled={!name.trim()}>
            save
          </Button>
        </form>
      </Sheet>
    </div>
  );
}

export default CardPage;
