/**
 * recipient address picker with contacts and recent addresses
 * used by all send forms (penumbra, zcash, cosmos)
 */

import { useState, useMemo } from 'react';
import { PersonIcon, ClockIcon } from '@radix-ui/react-icons';
import { useStore } from '../state';
import { contactsSelector, type ContactNetwork } from '../state/contacts';
import { recentAddressesSelector, type AddressNetwork } from '../state/recent-addresses';
import { cn } from '@repo/ui/lib/utils';

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

  if (!show) return null;

  const hasRecent = recentAddresses.length > 0;
  const hasContacts = networkContacts.length > 0;

  if (!hasRecent && !hasContacts) return null;

  return (
    <div className='mt-2'>
      {/* tabs */}
      {hasRecent && hasContacts && (
        <div className='flex gap-2 mb-1.5'>
          <button
            onClick={() => setTab('recent')}
            className={cn(
              'flex items-center gap-1 text-xs transition-colors',
              tab === 'recent' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <ClockIcon className='h-3 w-3' />
            recent
          </button>
          <button
            onClick={() => setTab('contacts')}
            className={cn(
              'flex items-center gap-1 text-xs transition-colors',
              tab === 'contacts' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <PersonIcon className='h-3 w-3' />
            contacts
          </button>
        </div>
      )}

      {/* single label when only one type exists */}
      {hasRecent && !hasContacts && (
        <p className='flex items-center gap-1 text-xs text-muted-foreground mb-1'>
          <ClockIcon className='h-3 w-3' /> recent
        </p>
      )}
      {!hasRecent && hasContacts && (
        <p className='flex items-center gap-1 text-xs text-muted-foreground mb-1'>
          <PersonIcon className='h-3 w-3' /> contacts
        </p>
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
                className='rounded bg-muted/50 px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors'
              >
                {result ? result.contact.name : `${r.address.slice(0, 8)}...${r.address.slice(-4)}`}
              </button>
            );
          })}
        </div>
      )}

      {/* contacts list */}
      {(tab === 'contacts' || !hasRecent) && hasContacts && (
        <div className='flex flex-wrap gap-1'>
          {networkContacts.map(({ contact, addresses }) =>
            addresses.map(addr => (
              <button
                key={addr.id}
                onClick={() => onSelect(addr.address)}
                className='rounded bg-muted/50 px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors'
              >
                {contact.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
