/**
 * one contact (Contact.dc.html): their seal and name, message and pay, one
 * row per address (a sheet to copy, send or remove it), rename, and their
 * seal to compare when you meet. A penumbra-only wallet gets no zcash
 * actions: every action goes through the address row's own send gate.
 */

import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { CopyButton } from '@repo/ui/components/ui/copy-button';
import { Input } from '@repo/ui/components/ui/input';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { ZidSeal } from '@repo/ui/components/ui/zid-seal';
import { useStore } from '../../../state';
import type { Contact, ContactAddress } from '../../../state/contacts';
import { selectEffectiveKeyInfo } from '../../../state/keyring';
import { keyInfoSupportsNetwork } from '../../../state/keyring/vault-ops';
import { useShareCard } from '../../../hooks/use-share-card';
import { ScreenHeader } from '../../../components/screen-header';
import { PopupPath, threadPath } from '../paths';
import { shortAddress } from '../inbox/threads';
import { contactStatus, networkOf } from '.';

type Open =
  | { kind: 'address'; address: ContactAddress }
  | { kind: 'add' | 'rename' | 'seal' | 'remove' };

/** send to one of a contact's addresses, on that address's network - when this wallet can */
const useSendTo = () => {
  const navigate = useNavigate();
  const keyInfo = useStore(selectEffectiveKeyInfo);
  return (addr: ContactAddress | undefined): (() => void) | undefined => {
    const network = addr?.network;
    if (!addr || (network !== 'zcash' && network !== 'penumbra')) {
      return undefined;
    }
    if (!keyInfo || !keyInfoSupportsNetwork(keyInfo, network)) {
      return undefined;
    }
    return () => navigate(PopupPath.SEND, { state: { prefillRecipient: addr.address, network } });
  };
};

const TextSheet = ({
  title,
  placeholder,
  initial = '',
  action,
  open,
  onClose,
  onSave,
}: {
  title: string;
  placeholder: string;
  initial?: string;
  action: string;
  open: boolean;
  onClose: () => void;
  onSave: (value: string) => Promise<void>;
}) => {
  const [value, setValue] = useState(initial);
  return (
    <Sheet open={open} onOpenChange={o => !o && onClose()} title={title}>
      <form
        className='flex flex-col gap-3'
        onSubmit={e => {
          e.preventDefault();
          void onSave(value.trim()).then(onClose);
        }}
      >
        <Input
          aria-label={placeholder}
          placeholder={placeholder}
          value={value}
          onChange={e => setValue(e.target.value)}
          autoFocus
        />
        <Button type='submit' disabled={!value.trim()}>
          {action}
        </Button>
      </form>
    </Sheet>
  );
};

const ContactView = ({ contact }: { contact: Contact }) => {
  const navigate = useNavigate();
  const sendTo = useSendTo();
  const shareCard = useShareCard();
  const { updateContact, addAddress, removeAddress, removeContact } = useStore(s => s.contacts);
  const [open, setOpen] = useState<Open>();
  const [shareFailed, setShareFailed] = useState(false);
  const close = () => setOpen(undefined);
  const status = contactStatus(contact);
  // the first address this wallet can act on
  const usable = contact.addresses.find(a => sendTo(a));
  const pay = sendTo(usable);
  const hasZcash = contact.addresses.some(a => a.network === 'zcash');

  return (
    <div className='flex flex-col gap-4 px-4 py-[18px]'>
      <div className='flex items-center gap-4'>
        <ZidSeal hex={contact.zid} size={66} />
        <span className='flex min-w-0 flex-col gap-1'>
          <span className='truncate font-display text-[22px] text-fg-high'>{contact.name}</span>
          <span className={`text-[11px] ${status.warn ? 'text-warn' : 'text-fg-muted'}`}>
            {status.line}
          </span>
        </span>
      </div>

      {usable && (
        <div className='flex gap-2'>
          <Button
            variant='secondary'
            className='h-11 flex-1'
            onClick={() => navigate(threadPath(usable.address.toLowerCase()))}
          >
            message
          </Button>
          <Button className='h-11 flex-1' onClick={pay}>
            pay
          </Button>
        </div>
      )}

      <RowGroup>
        {contact.addresses.map(a => (
          <Row
            key={a.id}
            type='value'
            label={a.network}
            value={shortAddress(a.address)}
            onPress={() => setOpen({ kind: 'address', address: a })}
          />
        ))}
        <Row type='screen' label='add an address' onPress={() => setOpen({ kind: 'add' })} />
      </RowGroup>

      <RowGroup>
        <Row type='screen' label='rename' onPress={() => setOpen({ kind: 'rename' })} />
        {contact.zid && (
          <Row type='screen' label='check seal again' onPress={() => setOpen({ kind: 'seal' })} />
        )}
        {/* until both cards carry the discovery key, neither side can be found */}
        {!contact.card && shareCard && hasZcash && (
          <Row
            type='screen'
            label='send them your card'
            onPress={() => void shareCard(contact).then(ok => setShareFailed(!ok))}
          />
        )}
      </RowGroup>
      {shareFailed && (
        <StatusSlot tone='danger'>
          sorry, zafu could not make an address for this card. please unlock and try again.
        </StatusSlot>
      )}

      <Button variant='quiet' className='self-start' onClick={() => setOpen({ kind: 'remove' })}>
        remove {contact.name}
      </Button>

      {open?.kind === 'address' && (
        <Sheet open onOpenChange={o => !o && close()} title={open.address.network}>
          <span className='break-all font-mono text-xs text-fg-high'>{open.address.address}</span>
          <div className='flex gap-2'>
            <CopyButton
              text={open.address.address}
              label='copy'
              variant='secondary'
              size='md'
              className='flex-1'
            />
            {sendTo(open.address) && (
              <Button className='flex-1' onClick={sendTo(open.address)}>
                send
              </Button>
            )}
          </div>
          <Button
            variant='danger'
            onClick={() => void removeAddress(contact.id, open.address.id).then(close)}
          >
            remove this address
          </Button>
        </Sheet>
      )}
      <TextSheet
        key={`add-${open?.kind === 'add'}`}
        title='add an address'
        placeholder='a zcash or penumbra address'
        action='add'
        open={open?.kind === 'add'}
        onClose={close}
        onSave={async address => {
          await addAddress(contact.id, { network: networkOf(address), address });
        }}
      />
      <TextSheet
        key={`rename-${open?.kind === 'rename'}`}
        title='rename'
        placeholder='name'
        initial={contact.name}
        action='save'
        open={open?.kind === 'rename'}
        onClose={close}
        onSave={name => updateContact(contact.id, { name })}
      />
      <Sheet open={open?.kind === 'seal'} onOpenChange={o => !o && close()} title='their seal'>
        <div className='flex flex-col items-center gap-3 py-2'>
          <ZidSeal hex={contact.zid} size={96} />
          <span className='text-center text-xs text-fg-muted'>
            when you meet, it should match the seal on their screen
          </span>
        </div>
      </Sheet>
      <Sheet
        open={open?.kind === 'remove'}
        onOpenChange={o => !o && close()}
        title={`remove ${contact.name}?`}
      >
        <span className='text-xs text-fg-muted'>your messages with them stay in people</span>
        <div className='flex gap-2'>
          <Button variant='secondary' className='flex-1' onClick={close}>
            not now
          </Button>
          <Button
            variant='danger'
            className='flex-1'
            onClick={() =>
              void removeContact(contact.id).then(() =>
                navigate(PopupPath.CONTACTS, { replace: true }),
              )
            }
          >
            remove
          </Button>
        </div>
      </Sheet>
    </div>
  );
};

export function ContactPage() {
  const id = decodeURIComponent(useParams()['contactId'] ?? '');
  const contact = useStore(s =>
    (Array.isArray(s.contacts.contacts) ? s.contacts.contacts : []).find(c => c.id === id),
  );
  return (
    <div className='flex min-h-full flex-col'>
      <ScreenHeader title={contact?.name ?? 'contact'} backPath={PopupPath.CONTACTS} />
      {contact ? (
        <ContactView contact={contact} />
      ) : (
        <p className='px-4 py-6 text-[13px] text-fg-muted'>this contact is not here any more</p>
      )}
    </div>
  );
}

export default ContactPage;
