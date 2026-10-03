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
import type { Contact } from '../../../state/contacts';
import { ScreenHeader } from '../../../components/screen-header';
import { PopupPath, contactPath } from '../paths';
import { looksLikeLink } from '../../../links/router';
import { QrScanner } from '../../../shared/components/qr-scanner';
import { ChainRow, useAddressDraft } from './chain-row';

/**
 * a contact's line under the name: whether friends on sites can find each
 * other (their card carried the key), or only an address is known. Said
 * calmly: address only is not a fault, it just cannot be found.
 */
export const contactStatus = (c: Contact): { line: string; warn?: boolean } =>
  c.card
    ? { line: 'from a card · can be found' }
    : c.zid
      ? { line: 'from an older card · ask for their new one' }
      : { line: 'address only · ask for their card' };

const byName = (a: Contact, b: Contact) =>
  Number(!!b.favorite) - Number(!!a.favorite) || a.name.localeCompare(b.name);

/** add someone: scan their card, paste their card link, or a name and an address */
export const AddContactSheet = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const navigate = useNavigate();
  const { addContact, addAddress } = useStore(s => s.contacts);
  const [name, setName] = useState('');
  const { address, setAddress, chain, pick, refused } = useAddressDraft();
  const [scanning, setScanning] = useState(false);
  /** a card link (or any zafu/zcash link) goes to the link reader, which opens the card */
  const follow = (text: string, via: 'pasted' | 'scanned'): boolean => {
    if (!looksLikeLink(text)) {
      return false;
    }
    onClose();
    navigate(PopupPath.LINK, { state: { uri: text.trim(), via } });
    return true;
  };
  const save = async () => {
    if (refused || (address.trim() && !chain)) {
      return;
    }
    const contact = await addContact({ name: name.trim() });
    if (address.trim() && chain) {
      await addAddress(contact.id, { network: chain, address: address.trim() });
    }
    onClose();
    navigate(contactPath(contact.id));
  };
  return (
    <>
      <Sheet open={open && !scanning} onOpenChange={o => !o && onClose()} title='add someone'>
        <Button variant='secondary' onClick={() => setScanning(true)}>
          <span className='i-lucide-scan-line size-4' aria-hidden='true' />
          scan their card
        </Button>
        <form
          className='flex flex-col gap-3'
          onSubmit={e => {
            e.preventDefault();
            if (!follow(address, 'pasted')) {
              void save();
            }
          }}
        >
          <Input
            aria-label='address'
            placeholder='their card link, or an address'
            value={address}
            onChange={e => {
              if (!follow(e.target.value, 'pasted')) {
                setAddress(e.target.value);
              }
            }}
            className='font-mono text-xs'
          />
          <Input
            aria-label='name'
            placeholder='name'
            value={name}
            onChange={e => setName(e.target.value)}
          />
          <ChainRow chain={chain} onPick={pick} />
          {refused && <span className='text-[11px] text-warn'>{refused}</span>}
          <Button type='submit' disabled={!name.trim() || !!refused}>
            save
          </Button>
        </form>
      </Sheet>
      {open && scanning && (
        <QrScanner
          title='scan their card'
          onScan={data => {
            setScanning(false);
            if (!follow(data, 'scanned')) {
              setAddress(data);
            }
          }}
          onClose={() => setScanning(false)}
        />
      )}
    </>
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
                  data-preload={contactPath(c.id)}
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
