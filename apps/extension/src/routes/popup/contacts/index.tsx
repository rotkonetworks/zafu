/**
 * contacts page - multi-network address book with expandable cards
 */

import { useState, useMemo, useCallback, useRef } from 'react';
import {
  PersonIcon,
  PlusIcon,
  MagnifyingGlassIcon,
  StarIcon,
  StarFilledIcon,
  Pencil1Icon,
  TrashIcon,
  CopyIcon,
  CheckIcon,
  DownloadIcon,
  UploadIcon,
  DotsHorizontalIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ArrowLeftIcon,
} from '@radix-ui/react-icons';
import { useNavigate } from 'react-router-dom';
import { PopupPath } from '../paths';
import { useStore } from '../../../state';
import {
  contactsSelector,
  type Contact,
  type ContactAddress,
  type ContactNetwork,
  type ContactsExport,
} from '../../../state/contacts';
import { cn } from '@repo/ui/lib/utils';

const NETWORK_LABELS: Record<ContactNetwork, string> = {
  penumbra: 'penumbra',
  zcash: 'zcash',
  cosmos: 'cosmos',
  polkadot: 'polkadot',
  kusama: 'kusama',
  ethereum: 'ethereum',
  bitcoin: 'bitcoin',
};

const NETWORK_COLORS: Record<ContactNetwork, string> = {
  penumbra: 'bg-purple-500/20 text-purple-400',
  zcash: 'bg-yellow-500/20 text-yellow-400',
  cosmos: 'bg-blue-500/20 text-blue-400',
  polkadot: 'bg-pink-500/20 text-pink-400',
  kusama: 'bg-red-500/20 text-red-400',
  ethereum: 'bg-indigo-500/20 text-indigo-400',
  bitcoin: 'bg-orange-500/20 text-orange-400',
};

/** modal for adding/editing a contact (name only) */
function ContactModal({
  onClose,
  onSave,
  editContact,
}: {
  onClose: () => void;
  onSave: (data: { name: string; notes?: string }) => void;
  editContact?: Contact;
}) {
  const [name, setName] = useState(editContact?.name ?? '');
  const [notes, setNotes] = useState(editContact?.notes ?? '');

  const canSave = name.trim().length > 0;

  const handleSave = () => {
    if (!canSave) return;
    onSave({ name: name.trim(), notes: notes.trim() || undefined });
    onClose();
  };

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/50'>
      <div className='w-full max-w-sm mx-4 rounded-xl bg-background border border-border p-4'>
        <h2 className='text-lg font-semibold mb-4'>
          {editContact ? 'edit contact' : 'new contact'}
        </h2>

        <div className='space-y-3'>
          <div>
            <label className='block text-xs text-muted-foreground mb-1'>name</label>
            <input
              type='text'
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='alice'
              autoFocus
              className='w-full rounded-lg border border-border bg-input px-3 py-2 text-sm focus:border-zigner-gold focus:outline-none'
            />
          </div>

          <div>
            <label className='block text-xs text-muted-foreground mb-1'>notes (optional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder='notes about this contact...'
              rows={2}
              className='w-full rounded-lg border border-border bg-input px-3 py-2 text-sm focus:border-zigner-gold focus:outline-none resize-none'
            />
          </div>
        </div>

        <div className='flex gap-2 mt-4'>
          <button
            onClick={onClose}
            className='flex-1 rounded-lg border border-border py-2 text-sm hover:bg-muted/50'
          >
            cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className='flex-1 rounded-lg bg-zigner-gold py-2 text-sm font-medium text-zigner-dark disabled:opacity-50'
          >
            save
          </button>
        </div>
      </div>
    </div>
  );
}

/** modal for adding/editing an address within a contact */
function AddressModal({
  onClose,
  onSave,
  editAddress,
}: {
  onClose: () => void;
  onSave: (data: Omit<ContactAddress, 'id'>) => void;
  editAddress?: ContactAddress;
}) {
  const [network, setNetwork] = useState<ContactNetwork>(editAddress?.network ?? 'penumbra');
  const [address, setAddress] = useState(editAddress?.address ?? '');
  const [chainId, setChainId] = useState(editAddress?.chainId ?? '');
  const [notes, setNotes] = useState(editAddress?.notes ?? '');

  const canSave = address.trim().length > 0;

  const handleSave = () => {
    if (!canSave) return;
    onSave({
      network,
      address: address.trim(),
      chainId: network === 'cosmos' ? chainId.trim() || undefined : undefined,
      notes: notes.trim() || undefined,
    });
    onClose();
  };

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/50'>
      <div className='w-full max-w-sm mx-4 rounded-xl bg-background border border-border p-4'>
        <h2 className='text-lg font-semibold mb-4'>
          {editAddress ? 'edit address' : 'add address'}
        </h2>

        <div className='space-y-3'>
          <div>
            <label className='block text-xs text-muted-foreground mb-1'>network</label>
            <select
              value={network}
              onChange={(e) => setNetwork(e.target.value as ContactNetwork)}
              className='w-full rounded-lg border border-border bg-input px-3 py-2 text-sm focus:border-zigner-gold focus:outline-none'
            >
              {Object.entries(NETWORK_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          {network === 'cosmos' && (
            <div>
              <label className='block text-xs text-muted-foreground mb-1'>chain (optional)</label>
              <input
                type='text'
                value={chainId}
                onChange={(e) => setChainId(e.target.value)}
                placeholder='osmosis, noble, etc'
                className='w-full rounded-lg border border-border bg-input px-3 py-2 text-sm focus:border-zigner-gold focus:outline-none'
              />
            </div>
          )}

          <div>
            <label className='block text-xs text-muted-foreground mb-1'>address</label>
            <input
              type='text'
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder='paste address...'
              className='w-full rounded-lg border border-border bg-input px-3 py-2 text-sm font-mono text-xs focus:border-zigner-gold focus:outline-none'
            />
          </div>

          <div>
            <label className='block text-xs text-muted-foreground mb-1'>notes (optional)</label>
            <input
              type='text'
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder='notes for this address...'
              className='w-full rounded-lg border border-border bg-input px-3 py-2 text-sm focus:border-zigner-gold focus:outline-none'
            />
          </div>
        </div>

        <div className='flex gap-2 mt-4'>
          <button
            onClick={onClose}
            className='flex-1 rounded-lg border border-border py-2 text-sm hover:bg-muted/50'
          >
            cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className='flex-1 rounded-lg bg-zigner-gold py-2 text-sm font-medium text-zigner-dark disabled:opacity-50'
          >
            save
          </button>
        </div>
      </div>
    </div>
  );
}

/** single address row within an expanded contact */
function AddressRow({
  address,
  onEdit,
  onDelete,
}: {
  address: ContactAddress;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copyAddress = useCallback(() => {
    void navigator.clipboard.writeText(address.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [address.address]);

  return (
    <div className='group flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/30'>
      <div className='flex items-center gap-2 min-w-0 flex-1'>
        <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium', NETWORK_COLORS[address.network])}>
          {NETWORK_LABELS[address.network]}
          {address.chainId && ` / ${address.chainId}`}
        </span>
        <span className='font-mono text-xs text-muted-foreground truncate'>
          {address.address}
        </span>
        <button
          onClick={copyAddress}
          className='shrink-0 p-1 text-muted-foreground hover:text-foreground'
        >
          {copied ? (
            <CheckIcon className='h-3 w-3 text-green-500' />
          ) : (
            <CopyIcon className='h-3 w-3' />
          )}
        </button>
      </div>

      <div className='flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity'>
        <button onClick={onEdit} className='p-1 rounded hover:bg-muted'>
          <Pencil1Icon className='h-3 w-3 text-muted-foreground' />
        </button>
        <button onClick={onDelete} className='p-1 rounded hover:bg-muted'>
          <TrashIcon className='h-3 w-3 text-red-500' />
        </button>
      </div>
    </div>
  );
}

/** expandable contact card */
function ContactCard({
  contact,
  onEditContact,
  onDeleteContact,
  onToggleFavorite,
  onAddAddress,
  onEditAddress,
  onDeleteAddress,
}: {
  contact: Contact;
  onEditContact: () => void;
  onDeleteContact: () => void;
  onToggleFavorite: () => void;
  onAddAddress: () => void;
  onEditAddress: (address: ContactAddress) => void;
  onDeleteAddress: (addressId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className='rounded-lg border border-border/50 bg-card overflow-hidden'>
      {/* header - always visible */}
      <div
        className='flex items-center justify-between p-3 cursor-pointer hover:bg-muted/30'
        onClick={() => setExpanded(!expanded)}
      >
        <div className='flex items-center gap-3'>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
            className='p-0.5'
          >
            {expanded ? (
              <ChevronDownIcon className='h-4 w-4 text-muted-foreground' />
            ) : (
              <ChevronRightIcon className='h-4 w-4 text-muted-foreground' />
            )}
          </button>

          <div className='flex h-8 w-8 items-center justify-center rounded-full bg-primary/10'>
            <PersonIcon className='h-4 w-4 text-primary' />
          </div>

          <div>
            <div className='flex items-center gap-2'>
              <span className='font-medium'>{contact.name}</span>
              <span className='text-xs text-muted-foreground'>
                {contact.addresses.length} address{contact.addresses.length !== 1 && 'es'}
              </span>
            </div>
            {contact.notes && (
              <p className='text-xs text-muted-foreground truncate max-w-[180px]'>
                {contact.notes}
              </p>
            )}
          </div>
        </div>

        <div className='flex items-center gap-1' onClick={(e) => e.stopPropagation()}>
          <button
            onClick={onToggleFavorite}
            className='p-1.5 rounded hover:bg-muted'
          >
            {contact.favorite ? (
              <StarFilledIcon className='h-4 w-4 text-yellow-500' />
            ) : (
              <StarIcon className='h-4 w-4 text-muted-foreground' />
            )}
          </button>
          <button onClick={onEditContact} className='p-1.5 rounded hover:bg-muted'>
            <Pencil1Icon className='h-4 w-4 text-muted-foreground' />
          </button>
          <button onClick={onDeleteContact} className='p-1.5 rounded hover:bg-muted'>
            <TrashIcon className='h-4 w-4 text-red-500' />
          </button>
        </div>
      </div>

      {/* expanded addresses */}
      {expanded && (
        <div className='border-t border-border/30 bg-muted/10'>
          {contact.addresses.length === 0 ? (
            <div className='p-4 text-center'>
              <p className='text-xs text-muted-foreground'>no addresses yet</p>
            </div>
          ) : (
            <div className='py-1'>
              {contact.addresses.map((addr) => (
                <AddressRow
                  key={addr.id}
                  address={addr}
                  onEdit={() => onEditAddress(addr)}
                  onDelete={() => onDeleteAddress(addr.id)}
                />
              ))}
            </div>
          )}

          {/* add address button */}
          <div className='p-2 border-t border-border/30'>
            <button
              onClick={onAddAddress}
              className='flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-border py-2 text-xs text-muted-foreground hover:border-zigner-gold hover:text-zigner-gold transition-colors'
            >
              <PlusIcon className='h-3 w-3' />
              add address
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ContactsPage() {
  const navigate = useNavigate();
  const contacts = useStore(contactsSelector);
  const [search, setSearch] = useState('');
  const [showContactModal, setShowContactModal] = useState(false);
  const [showAddressModal, setShowAddressModal] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | undefined>();
  const [editingAddress, setEditingAddress] = useState<{ contactId: string; address?: ContactAddress } | undefined>();
  const [filter, setFilter] = useState<'all' | 'favorites'>('all');
  const [showMenu, setShowMenu] = useState(false);
  const [importStatus, setImportStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // export contacts as JSON file download
  const handleExport = useCallback(() => {
    const data = contacts.exportContacts();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `zafu-contacts-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setShowMenu(false);
  }, [contacts]);

  // import contacts from JSON file
  const handleImportFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        const data = JSON.parse(text) as ContactsExport;
        const count = await contacts.importContacts(data, 'merge');
        setImportStatus({ type: 'success', message: `imported ${count} contacts` });
        setTimeout(() => setImportStatus(null), 3000);
      } catch (err) {
        setImportStatus({
          type: 'error',
          message: err instanceof Error ? err.message : 'failed to import',
        });
        setTimeout(() => setImportStatus(null), 3000);
      }

      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      setShowMenu(false);
    },
    [contacts]
  );

  const filteredContacts = useMemo(() => {
    let result = contacts.contacts;

    if (filter === 'favorites') {
      result = result.filter((c) => c.favorite);
    }

    if (search) {
      result = contacts.search(search);
    }

    // sort: favorites first, then by name
    return [...result].sort((a, b) => {
      if (a.favorite && !b.favorite) return -1;
      if (!a.favorite && b.favorite) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [contacts, search, filter]);

  // contact handlers
  const handleSaveContact = useCallback(
    async (data: { name: string; notes?: string }) => {
      if (editingContact) {
        await contacts.updateContact(editingContact.id, data);
      } else {
        await contacts.addContact(data);
      }
      setEditingContact(undefined);
    },
    [contacts, editingContact]
  );

  const handleEditContact = (contact: Contact) => {
    setEditingContact(contact);
    setShowContactModal(true);
  };

  const handleDeleteContact = async (id: string) => {
    await contacts.removeContact(id);
  };

  // address handlers
  const handleSaveAddress = useCallback(
    async (data: Omit<ContactAddress, 'id'>) => {
      if (!editingAddress) return;

      if (editingAddress.address) {
        // editing existing address
        await contacts.updateAddress(editingAddress.contactId, editingAddress.address.id, data);
      } else {
        // adding new address
        await contacts.addAddress(editingAddress.contactId, data);
      }
      setEditingAddress(undefined);
    },
    [contacts, editingAddress]
  );

  const handleAddAddress = (contactId: string) => {
    setEditingAddress({ contactId });
    setShowAddressModal(true);
  };

  const handleEditAddress = (contactId: string, address: ContactAddress) => {
    setEditingAddress({ contactId, address });
    setShowAddressModal(true);
  };

  const handleDeleteAddress = async (contactId: string, addressId: string) => {
    await contacts.removeAddress(contactId, addressId);
  };

  return (
    <div className='flex flex-col h-full'>
      {/* hidden file input for import */}
      <input
        type='file'
        ref={fileInputRef}
        accept='.json'
        onChange={handleImportFile}
        className='hidden'
      />

      {/* header */}
      <div className='flex items-center justify-between px-4 py-3 border-b border-border/40'>
        <div className='flex items-center gap-2'>
          <button
            onClick={() => navigate(PopupPath.INDEX)}
            className='p-1 rounded hover:bg-muted/50'
          >
            <ArrowLeftIcon className='h-4 w-4' />
          </button>
          <h1 className='text-lg font-medium'>contacts</h1>
        </div>
        <div className='flex items-center gap-2'>
          {/* menu button */}
          <div className='relative'>
            <button
              onClick={() => setShowMenu(!showMenu)}
              className='rounded-lg p-1.5 hover:bg-muted transition-colors'
            >
              <DotsHorizontalIcon className='h-5 w-5' />
            </button>
            {showMenu && (
              <>
                <div className='fixed inset-0 z-40' onClick={() => setShowMenu(false)} />
                <div className='absolute right-0 top-full mt-1 z-50 w-40 rounded-lg border border-border bg-background shadow-lg'>
                  <button
                    onClick={handleExport}
                    className='flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors'
                  >
                    <DownloadIcon className='h-4 w-4' />
                    export
                  </button>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className='flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors'
                  >
                    <UploadIcon className='h-4 w-4' />
                    import
                  </button>
                </div>
              </>
            )}
          </div>
          {/* add contact button */}
          <button
            onClick={() => {
              setEditingContact(undefined);
              setShowContactModal(true);
            }}
            className='flex items-center gap-1 rounded-lg bg-zigner-gold px-3 py-1.5 text-sm font-medium text-zigner-dark'
          >
            <PlusIcon className='h-4 w-4' />
            add
          </button>
        </div>
      </div>

      {/* import status toast */}
      {importStatus && (
        <div
          className={cn(
            'mx-4 mt-2 rounded-lg px-3 py-2 text-sm',
            importStatus.type === 'success'
              ? 'bg-green-500/10 text-green-500 border border-green-500/30'
              : 'bg-red-500/10 text-red-500 border border-red-500/30'
          )}
        >
          {importStatus.message}
        </div>
      )}

      {/* search and filter */}
      <div className='px-4 py-3 space-y-2'>
        <div className='relative'>
          <MagnifyingGlassIcon className='absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground' />
          <input
            type='text'
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder='search contacts...'
            className='w-full rounded-lg border border-border bg-input pl-9 pr-3 py-2 text-sm focus:border-zigner-gold focus:outline-none'
          />
        </div>
        <div className='flex gap-2'>
          <button
            onClick={() => setFilter('all')}
            className={cn(
              'rounded-full px-3 py-1 text-xs transition-colors',
              filter === 'all'
                ? 'bg-zigner-gold text-zigner-dark'
                : 'bg-muted/50 text-muted-foreground hover:bg-muted'
            )}
          >
            all
          </button>
          <button
            onClick={() => setFilter('favorites')}
            className={cn(
              'rounded-full px-3 py-1 text-xs transition-colors',
              filter === 'favorites'
                ? 'bg-zigner-gold text-zigner-dark'
                : 'bg-muted/50 text-muted-foreground hover:bg-muted'
            )}
          >
            favorites
          </button>
        </div>
      </div>

      {/* contacts list */}
      <div className='flex-1 overflow-y-auto px-4 pb-4'>
        {filteredContacts.length === 0 ? (
          <div className='flex flex-col items-center justify-center gap-3 py-12 text-center'>
            <div className='rounded-full bg-primary/10 p-4'>
              <PersonIcon className='h-8 w-8 text-primary' />
            </div>
            <div>
              <p className='text-sm font-medium'>no contacts</p>
              <p className='text-xs text-muted-foreground'>
                {search ? 'no contacts match your search' : 'add your first contact to get started'}
              </p>
            </div>
          </div>
        ) : (
          <div className='space-y-2'>
            {filteredContacts.map((contact) => (
              <ContactCard
                key={contact.id}
                contact={contact}
                onEditContact={() => handleEditContact(contact)}
                onDeleteContact={() => void handleDeleteContact(contact.id)}
                onToggleFavorite={() => void contacts.toggleFavorite(contact.id)}
                onAddAddress={() => handleAddAddress(contact.id)}
                onEditAddress={(addr) => handleEditAddress(contact.id, addr)}
                onDeleteAddress={(addrId) => void handleDeleteAddress(contact.id, addrId)}
              />
            ))}
          </div>
        )}
      </div>

      {/* contact modal */}
      {showContactModal && (
        <ContactModal
          onClose={() => {
            setShowContactModal(false);
            setEditingContact(undefined);
          }}
          onSave={handleSaveContact}
          editContact={editingContact}
        />
      )}

      {/* address modal */}
      {showAddressModal && editingAddress && (
        <AddressModal
          onClose={() => {
            setShowAddressModal(false);
            setEditingAddress(undefined);
          }}
          onSave={handleSaveAddress}
          editAddress={editingAddress.address}
        />
      )}
    </div>
  );
}

export default ContactsPage;
