/**
 * contacts (Contacts.dc.html): everyone saved, one search, one list.
 * Favourites sort first. A row opens that person; "add" is a sheet.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { ZidSeal } from '@repo/ui/components/ui/zid-seal';
import { useStore } from '../../../state';
import type { Contact, ContactNetwork } from '../../../state/contacts';
import { ScreenHeader } from '../../../components/screen-header';
import { PopupPath, contactPath } from '../paths';

/** the network an address is on, read from its prefix */
export const networkOf = (address: string): ContactNetwork =>
  /^penumbra/i.test(address.trim()) ? 'penumbra' : 'zcash';

/** a contact's line under the name: whether they gave you a card or only an address */
export const contactStatus = (c: Contact): { line: string; warn?: boolean } =>
  c.zid ? { line: 'from a card' } : { line: 'address only · ask for their card', warn: true };

const byName = (a: Contact, b: Contact) =>
  Number(!!b.favorite) - Number(!!a.favorite) || a.name.localeCompare(b.name);

/** add someone: a name and an address, one sheet */
export const AddContactSheet = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const navigate = useNavigate();
  const { addContact, addAddress } = useStore(s => s.contacts);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const save = async () => {
    const contact = await addContact({ name: name.trim() });
    if (address.trim()) {
      await addAddress(contact.id, { network: networkOf(address), address: address.trim() });
    }
    onClose();
    navigate(contactPath(contact.id));
  };
  return (
    <Sheet open={open} onOpenChange={o => !o && onClose()} title='add someone'>
      <form
        className='flex flex-col gap-3'
        onSubmit={e => {
          e.preventDefault();
          void save();
        }}
      >
        <Input
          aria-label='name'
          placeholder='name'
          value={name}
          onChange={e => setName(e.target.value)}
          autoFocus
        />
        <Input
          aria-label='address'
          placeholder='their zcash or penumbra address'
          value={address}
          onChange={e => setAddress(e.target.value)}
          className='font-mono text-xs'
        />
        <Button type='submit' disabled={!name.trim()}>
          save
        </Button>
      </form>
    </Sheet>
  );
};

export function ContactsPage() {
  const navigate = useNavigate();
  const contacts = useStore(s => s.contacts.contacts);
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(params.get('add') === '1');

  // a tx row's "to <contact>" used to land on /contacts?open=<id>
  const openId = params.get('open');
  useEffect(() => {
    if (openId) {
      navigate(contactPath(openId), { replace: true });
    } else if (params.has('add')) {
      setParams({}, { replace: true });
    }
  }, [openId, params, navigate, setParams]);

  const list = useMemo(() => {
    const all = Array.isArray(contacts) ? contacts : [];
    const q = query.trim().toLowerCase();
    return all
      .filter(
        c =>
          !q ||
          c.name.toLowerCase().includes(q) ||
          c.addresses.some(a => a.address.toLowerCase().includes(q)),
      )
      .sort(byName);
  }, [contacts, query]);
  const empty = !(Array.isArray(contacts) && contacts.length);

  return (
    <div className='flex min-h-full flex-col'>
      <ScreenHeader
        title='contacts'
        backPath={PopupPath.INBOX}
        meta={
          <button
            type='button'
            aria-label='add contact'
            onClick={() => setAdding(true)}
            className='h-8 border border-border-soft bg-elev-1 px-2.5 text-xs text-zigner-gold hover:bg-elev-2'
          >
            add
          </button>
        }
      />
      <div className='flex flex-col gap-2.5 px-4 py-3.5'>
        {!empty && (
          <Input
            aria-label='search contacts'
            placeholder='search'
            value={query}
            onChange={e => setQuery(e.target.value)}
            className='h-11'
          />
        )}
        {list.length > 0 ? (
          <div className='flex flex-col divide-y divide-border-soft border border-border-soft bg-elev-1'>
            {list.map(c => {
              const status = contactStatus(c);
              return (
                <button
                  key={c.id}
                  type='button'
                  onClick={() => navigate(contactPath(c.id))}
                  className='flex h-14 items-center gap-3 px-3 text-left transition-colors hover:bg-elev-2'
                >
                  <ZidSeal hex={c.zid} size={c.zid ? 26 : 30} />
                  <span className='flex min-w-0 grow flex-col gap-[3px]'>
                    <span className='truncate text-sm text-fg-high'>{c.name}</span>
                    <span
                      className={`truncate text-[11px] ${status.warn ? 'text-warn' : 'text-fg-muted'}`}
                    >
                      {status.line}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className='flex flex-col items-start gap-3 py-4'>
            <span className='text-[13px] text-fg-muted'>
              {empty ? 'no one saved yet' : 'no one by that name'}
            </span>
            {empty && (
              <Button variant='secondary' size='sm' onClick={() => setAdding(true)}>
                add someone
              </Button>
            )}
          </div>
        )}
      </div>
      <AddContactSheet open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}

export default ContactsPage;
