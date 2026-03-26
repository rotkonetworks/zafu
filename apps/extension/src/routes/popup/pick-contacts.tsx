/**
 * Contact picker popup — opened by external apps via zafu_pick_contacts.
 *
 * Shows the user's contacts. User selects who to share.
 * Returns app-scoped opaque handles (SHA-256), never real pubkeys.
 *
 * The page (untrusted) never sees contacts the user didn't select.
 */

import { useState, useMemo } from 'react';
import { useStore } from '../../state';
import { contactsSelector, type Contact } from '../../state/contacts';
import { cn } from '@repo/ui/lib/utils';

/** compute app-scoped handle: SHA-256(pubkey:appOrigin:zid:contact:v1) */
async function computeHandle(pubkey: string, appOrigin: string): Promise<string> {
  const input = new TextEncoder().encode(`${pubkey}:${appOrigin}:zid:contact:v1`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** get the "best" pubkey for a contact (first address, or contact id) */
function contactPubkey(contact: Contact): string {
  // use first address as the pubkey identifier
  if (contact.addresses.length > 0) return contact.addresses[0]!.address;
  return contact.id;
}

export function ContactPicker() {
  // read params from URL hash: ?app=...&purpose=...&max=...&requestId=...
  const params = useMemo(() => {
    const search = new URLSearchParams(window.location.hash.split('?')[1] || '');
    return {
      app: search.get('app') || 'unknown',
      purpose: search.get('purpose') || 'pick contacts',
      max: parseInt(search.get('max') || '1', 10),
      requestId: search.get('requestId') || '',
    };
  }, []);

  const { contacts } = useStore(contactsSelector);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!search) return contacts;
    const q = search.toLowerCase();
    return contacts.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.addresses.some(a => a.address.toLowerCase().includes(q))
    );
  }, [contacts, search]);

  const toggleContact = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < params.max) {
        next.add(id);
      }
      return next;
    });
  };

  const handleConfirm = async () => {
    const results: Array<{ handle: string; displayName: string }> = [];
    for (const contact of contacts) {
      if (!selected.has(contact.id)) continue;
      const pubkey = contactPubkey(contact);
      const handle = await computeHandle(pubkey, params.app);
      results.push({ handle, displayName: contact.name });
    }

    // send result back to service worker → back to the requesting page
    chrome.runtime.sendMessage({
      type: 'zafu_pick_contacts_result',
      requestId: params.requestId,
      contacts: results,
    });

    // close this popup window
    window.close();
  };

  const handleCancel = () => {
    chrome.runtime.sendMessage({
      type: 'zafu_pick_contacts_result',
      requestId: params.requestId,
      contacts: [],
    });
    window.close();
  };

  return (
    <div className="flex flex-col h-full bg-background">
      {/* header */}
      <div className="px-4 pt-4 pb-2">
        <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
          {params.app}
        </div>
        <div className="text-sm font-medium">{params.purpose}</div>
        <div className="text-xs text-muted-foreground mt-1">
          select up to {params.max} contact{params.max > 1 ? 's' : ''}
        </div>
      </div>

      {/* search */}
      <div className="px-4 pb-2">
        <input
          className="w-full px-3 py-1.5 text-xs bg-card border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
          placeholder="search contacts..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          autoFocus
        />
      </div>

      {/* contact list */}
      <div className="flex-1 overflow-y-auto px-2">
        {filtered.length === 0 ? (
          <div className="text-center text-xs text-muted-foreground py-8">
            {contacts.length === 0 ? 'no contacts yet' : 'no matches'}
          </div>
        ) : (
          filtered.map(contact => {
            const isSelected = selected.has(contact.id);
            return (
              <button
                key={contact.id}
                className={cn(
                  'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg mb-1 transition-colors text-left',
                  isSelected
                    ? 'bg-primary/10 border border-primary/30'
                    : 'hover:bg-card border border-transparent',
                )}
                onClick={() => toggleContact(contact.id)}
              >
                {/* avatar */}
                <div className={cn(
                  'w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold',
                  isSelected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                )}>
                  {contact.name.charAt(0).toUpperCase()}
                </div>

                {/* name + address preview */}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{contact.name}</div>
                  {contact.addresses.length > 0 && (
                    <div className="text-xs text-muted-foreground truncate">
                      {contact.addresses[0]!.network} - {contact.addresses[0]!.address.slice(0, 12)}...
                    </div>
                  )}
                </div>

                {/* check indicator */}
                <div className={cn(
                  'w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors',
                  isSelected ? 'border-primary bg-primary' : 'border-muted-foreground/30',
                )}>
                  {isSelected && (
                    <svg className="w-3 h-3 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>

      {/* action bar */}
      <div className="px-4 py-3 border-t border-border flex gap-2">
        <button
          className="flex-1 px-3 py-2 text-xs rounded-md border border-border text-muted-foreground hover:text-foreground transition-colors"
          onClick={handleCancel}
        >
          cancel
        </button>
        <button
          className={cn(
            'flex-1 px-3 py-2 text-xs rounded-md font-medium transition-colors',
            selected.size > 0
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : 'bg-muted text-muted-foreground cursor-not-allowed',
          )}
          disabled={selected.size === 0}
          onClick={handleConfirm}
        >
          share {selected.size > 0 ? `(${selected.size})` : ''}
        </button>
      </div>
    </div>
  );
}
