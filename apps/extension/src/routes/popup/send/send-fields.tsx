/**
 * The send form's fields and pickers, shared by every network's form: the
 * "to" field with its contacts and scan buttons, the big amount field, the
 * contacts sheet and the one-of-many picker sheet. Board Send.
 */

import { useState, type ReactNode } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { useStore } from '../../../state';
import { contactsSelector, type Contact, type ContactNetwork } from '../../../state/contacts';
import { recentAddressesSelector, type AddressNetwork } from '../../../state/recent-addresses';
import { Sensitive } from '../../../components/sensitive';
import { Helper, shortAddress } from './send-ui';

export interface BookRow {
  label: string;
  address: string;
  contactId?: string;
  addressId?: string;
}

const lastUsed = (contact: Contact, network: ContactNetwork) =>
  contact.addresses.reduce(
    (max, a) => (a.network === network ? Math.max(max, a.lastUsedAt ?? 0) : max),
    0,
  );

/**
 * Contacts with an address on this network (favorites first, then most
 * recently used), then the caller's own other wallets, then recent payees.
 */
export function ContactsSheet({
  network,
  open,
  onOpenChange,
  onPick,
  own = [],
}: {
  network: ContactNetwork & AddressNetwork;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (row: BookRow) => void;
  own?: readonly BookRow[];
}) {
  const [query, setQuery] = useState('');
  const { contacts, getFavorites } = useStore(contactsSelector);
  const recent = useStore(recentAddressesSelector).getRecent(network, 10);
  const favoriteIds = new Set(getFavorites().map(c => c.id));
  const listed = (Array.isArray(contacts) ? contacts : []).filter(c =>
    c.addresses.some(a => a.network === network),
  );
  const ranked = [
    ...listed.filter(c => favoriteIds.has(c.id)),
    ...listed
      .filter(c => !favoriteIds.has(c.id))
      .sort((a, b) => lastUsed(b, network) - lastUsed(a, network)),
  ];
  const seen = new Set<string>();
  const rows: BookRow[] = [
    ...ranked.flatMap(contact =>
      contact.addresses
        .filter(a => a.network === network)
        .map(a => ({
          label: contact.name,
          address: a.address,
          contactId: contact.id,
          addressId: a.id,
        })),
    ),
    ...own,
    ...recent.map(r => ({ label: shortAddress(r.address), address: r.address })),
  ].filter(r => !!r.address && !seen.has(r.address) && !!seen.add(r.address));
  const q = query.trim().toLowerCase();
  const shown = rows.filter(
    r => !q || r.label.toLowerCase().includes(q) || r.address.toLowerCase().includes(q),
  );
  const close = (next: boolean) => {
    onOpenChange(next);
    setQuery('');
  };

  return (
    <Sheet open={open} onOpenChange={close} title='contacts'>
      <Input
        placeholder='search name or address'
        value={query}
        onChange={e => setQuery(e.target.value)}
      />
      <div className='min-h-0 overflow-y-auto'>
        {shown.length > 0 ? (
          <RowGroup>
            {shown.map(row => (
              <Row
                key={row.address}
                type='screen'
                label={row.label}
                description={shortAddress(row.address)}
                onPress={() => {
                  onPick(row);
                  close(false);
                }}
              />
            ))}
          </RowGroup>
        ) : (
          <p className='py-6 text-center text-xs text-fg-muted'>
            {q ? 'nothing matches that' : 'no saved addresses yet'}
          </p>
        )}
      </div>
    </Sheet>
  );
}

/** label above, the input, square tool buttons beside it, one helper line under */
export const ToField = ({
  id = 'send-to',
  label = 'to',
  value,
  onChange,
  placeholder = 'address or contact',
  warn,
  helper,
  onContacts,
  onScan,
  disabled,
  children,
}: {
  id?: string;
  label?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  warn?: boolean;
  helper?: ReactNode;
  onContacts?: () => void;
  onScan?: () => void;
  disabled?: boolean;
  /** under the input, above the helper (e.g. a name resolver) */
  children?: ReactNode;
}) => (
  <div className='flex flex-col gap-1.5'>
    <label htmlFor={id} className='text-xs text-fg-muted'>
      {label}
    </label>
    <div className='flex gap-1.5'>
      <Input
        id={id}
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        variant={warn ? 'warn' : 'default'}
        disabled={disabled}
        className='min-w-0 flex-1'
      />
      {onContacts && (
        <Button
          variant='secondary'
          onClick={onContacts}
          disabled={disabled}
          aria-label='contacts'
          className='size-12 shrink-0 bg-elev-1 px-0 text-fg-muted'
        >
          <span className='i-lucide-user size-4' />
        </Button>
      )}
      {onScan && (
        <Button
          variant='secondary'
          onClick={onScan}
          disabled={disabled}
          aria-label='scan a code'
          className='size-12 shrink-0 bg-elev-1 px-0 text-fg-muted'
        >
          <span className='i-lucide-scan size-4' />
        </Button>
      )}
    </div>
    {children}
    <Helper warn={warn}>{helper}</Helper>
  </div>
);

/**
 * The big amount: display-size digits, the unit, and max. With `onUnit` the
 * unit is the asset picker (penumbra, cosmos), otherwise a plain label.
 */
export const AmountField = ({
  id = 'send-amount',
  label = 'amount',
  value,
  onChange,
  unit,
  onUnit,
  available,
  onMax,
  canMax = true,
  warn,
  helper,
  disabled,
  autoFocus,
}: {
  id?: string;
  label?: string;
  value: string;
  onChange: (v: string) => void;
  unit: string;
  onUnit?: () => void;
  /** spendable, shown at the label's right; omitted until it is known */
  available?: string;
  onMax?: () => void;
  canMax?: boolean;
  warn?: boolean;
  helper?: ReactNode;
  disabled?: boolean;
  autoFocus?: boolean;
}) => (
  <div className='flex flex-col gap-1.5'>
    <div className='flex items-baseline justify-between'>
      <label htmlFor={id} className='text-xs text-fg-muted'>
        {label}
      </label>
      {available !== undefined && (
        <span className='text-[11px] text-fg-muted'>
          available <Sensitive>{available}</Sensitive>
        </span>
      )}
    </div>
    <div className='relative'>
      <Input
        id={id}
        inputMode='decimal'
        placeholder='0'
        value={value}
        onChange={e => onChange(e.target.value)}
        variant={warn ? 'warn' : 'default'}
        disabled={disabled}
        autoFocus={autoFocus}
        className={cn('h-14 pr-[130px] font-display text-2xl', warn && 'focus-visible:border-warn')}
      />
      <span className='absolute right-2 top-0 flex h-14 items-center gap-1'>
        {onUnit ? (
          <button
            type='button'
            onClick={onUnit}
            disabled={disabled}
            aria-label='choose asset'
            className='flex h-8 max-w-[76px] items-center gap-1 px-1.5 text-[13px] text-fg-muted transition-colors hover:text-fg-high'
          >
            <span className='truncate lowercase'>{unit}</span>
            <span className='i-lucide-chevron-down size-3 shrink-0' />
          </button>
        ) : (
          <span className='px-2 text-[13px] text-fg-muted lowercase'>{unit}</span>
        )}
        {onMax && (
          <Button
            variant='secondary'
            size='sm'
            onClick={onMax}
            disabled={disabled || !canMax}
            className='h-8 border-border-hard text-network-accent'
          >
            max
          </Button>
        )}
      </span>
    </div>
    <Helper warn={warn}>{helper}</Helper>
  </div>
);

export interface Pick<K extends string | number> {
  key: K;
  label: string;
  description?: string;
  /** right-hand value, e.g. a balance */
  value?: string;
}

/** choose one of many (asset, validator, chain): a sheet of rows */
export function PickSheet<K extends string | number>({
  title,
  open,
  onOpenChange,
  picks,
  onPick,
  empty = 'nothing here yet',
  head,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  picks: readonly Pick<K>[];
  onPick: (key: K) => void;
  empty?: string;
  /** above the rows, e.g. an assets / positions switch */
  head?: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title}>
      {head}
      <div className='min-h-0 overflow-y-auto'>
        {picks.length > 0 ? (
          <RowGroup>
            {picks.map(p => (
              <Row
                key={p.key}
                type='value'
                label={p.label}
                description={p.description}
                value={p.value}
                onPress={() => {
                  onPick(p.key);
                  onOpenChange(false);
                }}
              />
            ))}
          </RowGroup>
        ) : (
          <p className='py-6 text-center text-xs text-fg-muted'>{empty}</p>
        )}
      </div>
    </Sheet>
  );
}
