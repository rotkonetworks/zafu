/**
 * recipient address picker with contacts and recent addresses
 * used by all send forms (penumbra, zcash, cosmos)
 */

import { useState, useMemo } from 'react';
import { useStore } from '../state';
import { contactsSelector, type ContactNetwork } from '../state/contacts';
import { recentAddressesSelector, type AddressNetwork } from '../state/recent-addresses';
import { cn } from '@repo/ui/lib/utils';

const SHOW_SEARCH_THRESHOLD = 8;
const MAX_VISIBLE = 50;

interface RecipientPickerProps {
  /** current network for filtering contacts and recent addresses */
  network: ContactNetwork & AddressNetwork;
  /** called when user picks an address */
  onSelect: (address: string) => void;
  /** whether to show the picker (typically when recipient is empty) */
  show: boolean;
}

export function RecipientPicker({ network, onSelect, show }: RecipientPickerProps) {
  const [tab, setTab] = useState<'recent' | 'contacts'>('recent');
  const [search, setSearch] = useState('');
  const { getRecent } = useStore(recentAddressesSelector);
  const { contacts, findByAddress } = useStore(contactsSelector);

  const recentAddresses = useMemo(() => getRecent(network, 5), [getRecent, network]);

  // filter contacts to those with an address on this network
  const networkContacts = useMemo(() => {
    return contacts
      .filter(c => c.addresses.some(a => a.network === network))
      .map(c => ({
        contact: c,
        addresses: c.addresses.filter(a => a.network === network),
      }));
  }, [contacts, network]);

  // search-filtered contacts
  const filteredContacts = useMemo(() => {
    if (!search.trim()) return networkContacts.slice(0, MAX_VISIBLE);
    const q = search.toLowerCase();
    return networkContacts
      .filter(({ contact, addresses }) =>
        contact.name.toLowerCase().includes(q) ||
        addresses.some(a => a.address.toLowerCase().includes(q))
      )
      .slice(0, MAX_VISIBLE);
  }, [networkContacts, search]);

  if (!show) return null;

  const hasRecent = recentAddresses.length > 0;
  const hasContacts = networkContacts.length > 0;
  const showSearch = networkContacts.length >= SHOW_SEARCH_THRESHOLD;
  const showingContacts = tab === 'contacts' || !hasRecent;

  if (!hasRecent && !hasContacts) return null;

  return (
    <div className='mt-2'>
      {/* tabs */}
      {hasRecent && hasContacts && (
        <div className='flex gap-2 mb-1.5'>
          <button
            onClick={() => { setTab('recent'); setSearch(''); }}
            className={cn(
              'flex items-center gap-1 text-xs transition-colors',
              tab === 'recent' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <span className='i-lucide-clock h-3 w-3' />
            recent
          </button>
          <button
            onClick={() => setTab('contacts')}
            className={cn(
              'flex items-center gap-1 text-xs transition-colors',
              tab === 'contacts' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <span className='i-lucide-user h-3 w-3' />
            contacts ({networkContacts.length})
          </button>
        </div>
      )}

      {/* single label when only one type exists */}
      {hasRecent && !hasContacts && (
        <p className='flex items-center gap-1 text-xs text-muted-foreground mb-1'>
          <span className='i-lucide-clock h-3 w-3' /> recent
        </p>
      )}
      {!hasRecent && hasContacts && (
        <p className='flex items-center gap-1 text-xs text-muted-foreground mb-1'>
          <span className='i-lucide-user h-3 w-3' /> contacts ({networkContacts.length})
        </p>
      )}

      {/* search input — shown when contacts tab active and list is large */}
      {showingContacts && hasContacts && showSearch && (
        <div className='relative mb-1.5'>
          <span className='i-lucide-search absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground' />
          <input
            type='text'
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder='search contacts...'
            className='w-full rounded-lg border border-border/40 bg-input pl-7 pr-3 py-1.5 text-xs focus:border-zigner-gold focus:outline-none'
          />
        </div>
      )}

      {/* recent addresses */}
      {(tab === 'recent' || !hasContacts) && hasRecent && (
        <div className='flex flex-wrap gap-1'>
          {recentAddresses.map(r => {
            const result = findByAddress(r.address);
            return (
              <button
                key={r.address}
                onClick={() => onSelect(r.address)}
                className='rounded-md bg-muted/50 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/80 hover:text-foreground transition-colors'
              >
                {result ? result.contact.name : `${r.address.slice(0, 8)}...${r.address.slice(-4)}`}
              </button>
            );
          })}
        </div>
      )}

      {/* contacts list */}
      {showingContacts && hasContacts && (
        <div className='max-h-[200px] overflow-y-auto'>
          <div className='flex flex-wrap gap-1'>
            {filteredContacts.map(({ contact, addresses }) =>
              addresses.map(addr => (
                <button
                  key={addr.id}
                  onClick={() => onSelect(addr.address)}
                  className='rounded-md bg-muted/50 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/80 hover:text-foreground transition-colors'
                >
                  {contact.name}
                </button>
              ))
            )}
            {filteredContacts.length === 0 && search && (
              <p className='text-xs text-muted-foreground py-1'>no matches</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
