/**
 * save-to-contacts modal — shown after sending to a new address.
 *
 * offers two options:
 * 1. add address to an existing contact (dropdown)
 * 2. create a new contact with the address
 */

import { useState } from 'react';
import { useStore } from '../state';
import { contactsSelector, type ContactNetwork } from '../state/contacts';

interface SaveContactModalProps {
  address: string;
  network: ContactNetwork;
  onDone: () => void;
  onCancel: () => void;
}

export function SaveContactModal({ address, network, onDone, onCancel }: SaveContactModalProps) {
  const { contacts, addContact, addAddress } = useStore(contactsSelector);
  const [mode, setMode] = useState<'choose' | 'new'>('choose');
  const [newName, setNewName] = useState('');
  const [selectedContactId, setSelectedContactId] = useState('');
  const [saving, setSaving] = useState(false);

  const safeContacts = Array.isArray(contacts) ? contacts : [];

  const handleSaveExisting = async () => {
    if (!selectedContactId) return;
    setSaving(true);
    await addAddress(selectedContactId, { network, address });
    setSaving(false);
    onDone();
  };

  const handleSaveNew = async () => {
    if (!newName.trim()) return;
    setSaving(true);
    const contact = await addContact({ name: newName.trim() });
    await addAddress(contact.id, { network, address });
    setSaving(false);
    onDone();
  };

  return (
    <div className='rounded-lg border border-border-soft bg-elev-1 p-3'>
      <p className='text-sm font-medium mb-3'>save to contacts</p>

      {safeContacts.length > 0 && mode === 'choose' && (
        <>
          <select
            value={selectedContactId}
            onChange={e => setSelectedContactId(e.target.value)}
            className='w-full rounded-lg border border-border-soft bg-input px-3 py-2 text-sm focus:outline-none mb-2'
          >
            <option value=''>select existing contact...</option>
            {safeContacts.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>

          {selectedContactId && (
            <div className='flex gap-2 mb-2'>
              <button
                onClick={() => void handleSaveExisting()}
                disabled={saving}
                className='flex-1 rounded-lg bg-zigner-gold py-2 text-xs font-medium text-zigner-dark hover:bg-primary/90 transition-colors disabled:opacity-50'
              >
                add address
              </button>
              <button
                onClick={onCancel}
                className='flex-1 rounded-lg border border-border-soft py-2 text-xs text-fg-muted hover:text-fg-high transition-colors'
              >
                cancel
              </button>
            </div>
          )}

          {!selectedContactId && (
            <button
              onClick={() => setMode('new')}
              className='w-full text-xs text-fg-muted hover:text-fg-high transition-colors py-1'
            >
              + new contact
            </button>
          )}
        </>
      )}

      {(safeContacts.length === 0 || mode === 'new') && (
        <>
          <input
            type='text'
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder='contact name'
            autoFocus
            className='w-full rounded-lg border border-border-soft bg-input px-3 py-2 text-sm focus:outline-none mb-2'
          />
          <div className='flex gap-2'>
            <button
              onClick={() => void handleSaveNew()}
              disabled={!newName.trim() || saving}
              className='flex-1 rounded-lg bg-zigner-gold py-2 text-xs font-medium text-zigner-dark hover:bg-primary/90 transition-colors disabled:opacity-50'
            >
              save
            </button>
            <button
              onClick={safeContacts.length > 0 ? () => setMode('choose') : onCancel}
              className='flex-1 rounded-lg border border-border-soft py-2 text-xs text-fg-muted hover:text-fg-high transition-colors'
            >
              {safeContacts.length > 0 ? 'back' : 'cancel'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
