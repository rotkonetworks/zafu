/**
 * Add to contacts dialog
 * Allows creating a new contact or adding address to existing contact
 */

import { useState, useEffect } from 'react';
import { Cross2Icon, PersonIcon, PlusIcon } from '@radix-ui/react-icons';
import { useStore } from '../state';
import { contactsSelector, type ContactNetwork, type Contact } from '../state/contacts';
import { cn } from '@repo/ui/lib/utils';

interface AddContactDialogProps {
  address: string;
  network: ContactNetwork;
  onClose: () => void;
  onSuccess?: () => void;
}

export function AddContactDialog({
  address,
  network,
  onClose,
  onSuccess,
}: AddContactDialogProps) {
  const contacts = useStore(contactsSelector);
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [name, setName] = useState('');
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // default name is truncated address
  const defaultName = `${address.slice(0, 8)}...${address.slice(-6)}`;

  // check if address is already in contacts
  const existingEntry = contacts.findByAddress(address);

  useEffect(() => {
    if (existingEntry) {
      onClose(); // already in contacts, close dialog
    }
  }, [existingEntry, onClose]);

  const handleSubmit = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);

    try {
      if (mode === 'new') {
        // create new contact with the address
        const contactName = name.trim() || defaultName;
        const contact = await contacts.addContact({ name: contactName });
        await contacts.addAddress(contact.id, { network, address });
      } else if (selectedContact) {
        // add address to existing contact
        await contacts.addAddress(selectedContact.id, { network, address });
      }
      onSuccess?.();
      onClose();
    } catch (e) {
      console.error('Failed to add contact:', e);
    } finally {
      setIsSubmitting(false);
    }
  };

  const existingContacts = contacts.contacts;
  const canSubmit = mode === 'new' || selectedContact !== null;

  return (
    <>
      {/* backdrop */}
      <div
        className='fixed inset-0 z-50 bg-black/50'
        onClick={onClose}
      />

      {/* dialog */}
      <div className='fixed left-1/2 top-1/2 z-50 w-[90%] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background shadow-xl'>
        {/* header */}
        <div className='flex items-center justify-between border-b border-border px-4 py-3'>
          <h2 className='font-medium'>add to contacts</h2>
          <button
            onClick={onClose}
            className='rounded p-1 hover:bg-muted/50'
          >
            <Cross2Icon className='h-4 w-4' />
          </button>
        </div>

        {/* content */}
        <div className='p-4 space-y-4'>
          {/* address preview */}
          <div className='rounded-lg border border-border bg-muted/30 p-3'>
            <div className='text-xs text-muted-foreground mb-1'>address</div>
            <div className='text-sm font-mono break-all'>{address}</div>
            <div className='mt-1'>
              <span className='rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground'>
                {network}
              </span>
            </div>
          </div>

          {/* mode tabs */}
          <div className='flex rounded-lg border border-border overflow-hidden'>
            <button
              onClick={() => setMode('new')}
              className={cn(
                'flex-1 py-2 text-sm font-medium transition-colors',
                mode === 'new'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted/30 hover:bg-muted/50'
              )}
            >
              <PlusIcon className='h-4 w-4 inline mr-1' />
              new contact
            </button>
            <button
              onClick={() => setMode('existing')}
              disabled={existingContacts.length === 0}
              className={cn(
                'flex-1 py-2 text-sm font-medium transition-colors',
                mode === 'existing'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted/30 hover:bg-muted/50',
                existingContacts.length === 0 && 'opacity-50 cursor-not-allowed'
              )}
            >
              <PersonIcon className='h-4 w-4 inline mr-1' />
              existing
            </button>
          </div>

          {mode === 'new' ? (
            /* new contact form */
            <div>
              <label className='block text-xs text-muted-foreground mb-1'>
                contact name
              </label>
              <input
                type='text'
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={defaultName}
                className='w-full rounded-lg border border-border bg-input px-3 py-2 text-sm focus:border-zigner-gold focus:outline-none'
                autoFocus
              />
              <p className='text-xs text-muted-foreground mt-1'>
                leave empty to use address as name
              </p>
            </div>
          ) : (
            /* existing contact selector */
            <div>
              <label className='block text-xs text-muted-foreground mb-1'>
                select contact
              </label>
              <div className='max-h-40 overflow-y-auto rounded-lg border border-border'>
                {existingContacts.map((contact) => (
                  <button
                    key={contact.id}
                    onClick={() => setSelectedContact(contact)}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-muted/50',
                      selectedContact?.id === contact.id && 'bg-primary/10'
                    )}
                  >
                    <PersonIcon className='h-4 w-4 text-muted-foreground' />
                    <span className='truncate'>{contact.name}</span>
                    <span className='ml-auto text-xs text-muted-foreground'>
                      {contact.addresses.length} addr
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* footer */}
        <div className='flex gap-2 border-t border-border px-4 py-3'>
          <button
            onClick={onClose}
            className='flex-1 rounded-lg border border-border py-2 text-sm font-medium hover:bg-muted/50'
          >
            cancel
          </button>
          <button
            onClick={() => void handleSubmit()}
            disabled={!canSubmit || isSubmitting}
            className='flex-1 rounded-lg bg-zigner-gold py-2 text-sm font-medium text-zigner-dark disabled:opacity-50'
          >
            {isSubmitting ? 'adding...' : 'add contact'}
          </button>
        </div>
      </div>
    </>
  );
}
