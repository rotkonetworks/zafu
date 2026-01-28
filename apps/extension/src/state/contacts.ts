/**
 * contacts state slice - address book with multi-network support
 *
 * each contact (person) can have multiple addresses across different networks.
 * addresses are expandable in the UI.
 */

import type { AllSlices, SliceCreator } from '.';
import type { ExtensionStorage } from '@repo/storage-chrome/base';
import type { LocalStorageState } from '@repo/storage-chrome/local';

export type ContactNetwork = 'penumbra' | 'zcash' | 'cosmos' | 'polkadot' | 'kusama' | 'ethereum' | 'bitcoin';

/** a single address entry within a contact */
export interface ContactAddress {
  id: string;
  network: ContactNetwork;
  address: string;
  /** for cosmos chains (osmosis, noble, etc) */
  chainId?: string;
  /** notes specific to this address */
  notes?: string;
  /** last time this address was used for sending */
  lastUsedAt?: number;
}

/** a contact (person) with multiple addresses */
export interface Contact {
  id: string;
  name: string;
  /** general notes about the contact */
  notes?: string;
  favorite?: boolean;
  createdAt: number;
  /** addresses across different networks */
  addresses: ContactAddress[];
}

/** portable export format for sharing contacts */
export interface ContactsExport {
  version: 2;
  exportedAt: number;
  contacts: Array<{
    name: string;
    notes?: string;
    favorite?: boolean;
    addresses: Array<{
      network: ContactNetwork;
      address: string;
      chainId?: string;
      notes?: string;
    }>;
  }>;
}

export interface ContactsSlice {
  contacts: Contact[];

  /** add a new contact */
  addContact: (data: { name: string; notes?: string }) => Promise<Contact>;

  /** update contact info (name, notes, favorite) */
  updateContact: (id: string, updates: { name?: string; notes?: string }) => Promise<void>;

  /** remove a contact */
  removeContact: (id: string) => Promise<void>;

  /** toggle favorite status */
  toggleFavorite: (id: string) => Promise<void>;

  /** add an address to an existing contact */
  addAddress: (contactId: string, address: Omit<ContactAddress, 'id'>) => Promise<ContactAddress>;

  /** update an address within a contact */
  updateAddress: (contactId: string, addressId: string, updates: Partial<Omit<ContactAddress, 'id'>>) => Promise<void>;

  /** remove an address from a contact */
  removeAddress: (contactId: string, addressId: string) => Promise<void>;

  /** mark an address as used (updates lastUsedAt) */
  markAddressUsed: (contactId: string, addressId: string) => Promise<void>;

  /** find contact by address string */
  findByAddress: (address: string) => { contact: Contact; address: ContactAddress } | undefined;

  /** get all addresses for a specific network */
  getAddressesByNetwork: (network: ContactNetwork) => Array<{ contact: Contact; address: ContactAddress }>;

  /** get favorite contacts */
  getFavorites: () => Contact[];

  /** get recently used addresses */
  getRecentAddresses: (limit?: number) => Array<{ contact: Contact; address: ContactAddress }>;

  /** search contacts by name or address */
  search: (query: string) => Contact[];

  /** export all contacts to portable JSON format */
  exportContacts: () => ContactsExport;

  /** import contacts from portable JSON (returns count of imported) */
  importContacts: (data: ContactsExport, mode: 'merge' | 'replace') => Promise<number>;

  /** clear all contacts */
  clearAll: () => Promise<void>;
}

const generateId = () => crypto.randomUUID();

export const createContactsSlice =
  (local: ExtensionStorage<LocalStorageState>): SliceCreator<ContactsSlice> =>
  (set, get) => ({
    contacts: [],

    addContact: async (data) => {
      const contact: Contact = {
        id: generateId(),
        name: data.name.trim(),
        notes: data.notes?.trim() || undefined,
        createdAt: Date.now(),
        addresses: [],
      };

      set((state) => {
        state.contacts.contacts.push(contact);
      });

      await local.set('contacts' as keyof LocalStorageState, get().contacts.contacts as never);
      return contact;
    },

    updateContact: async (id, updates) => {
      set((state) => {
        const contact = state.contacts.contacts.find((c) => c.id === id);
        if (contact) {
          if (updates.name !== undefined) contact.name = updates.name.trim();
          if (updates.notes !== undefined) contact.notes = updates.notes.trim() || undefined;
        }
      });

      await local.set('contacts' as keyof LocalStorageState, get().contacts.contacts as never);
    },

    removeContact: async (id) => {
      set((state) => {
        state.contacts.contacts = state.contacts.contacts.filter((c) => c.id !== id);
      });

      await local.set('contacts' as keyof LocalStorageState, get().contacts.contacts as never);
    },

    toggleFavorite: async (id) => {
      set((state) => {
        const contact = state.contacts.contacts.find((c) => c.id === id);
        if (contact) {
          contact.favorite = !contact.favorite;
        }
      });

      await local.set('contacts' as keyof LocalStorageState, get().contacts.contacts as never);
    },

    addAddress: async (contactId, addressData) => {
      const addr: ContactAddress = {
        id: generateId(),
        network: addressData.network,
        address: addressData.address.trim(),
        chainId: addressData.chainId?.trim() || undefined,
        notes: addressData.notes?.trim() || undefined,
      };

      set((state) => {
        const contact = state.contacts.contacts.find((c) => c.id === contactId);
        if (contact) {
          contact.addresses.push(addr);
        }
      });

      await local.set('contacts' as keyof LocalStorageState, get().contacts.contacts as never);
      return addr;
    },

    updateAddress: async (contactId, addressId, updates) => {
      set((state) => {
        const contact = state.contacts.contacts.find((c) => c.id === contactId);
        if (contact) {
          const addr = contact.addresses.find((a) => a.id === addressId);
          if (addr) {
            if (updates.network !== undefined) addr.network = updates.network;
            if (updates.address !== undefined) addr.address = updates.address.trim();
            if (updates.chainId !== undefined) addr.chainId = updates.chainId.trim() || undefined;
            if (updates.notes !== undefined) addr.notes = updates.notes.trim() || undefined;
          }
        }
      });

      await local.set('contacts' as keyof LocalStorageState, get().contacts.contacts as never);
    },

    removeAddress: async (contactId, addressId) => {
      set((state) => {
        const contact = state.contacts.contacts.find((c) => c.id === contactId);
        if (contact) {
          contact.addresses = contact.addresses.filter((a) => a.id !== addressId);
        }
      });

      await local.set('contacts' as keyof LocalStorageState, get().contacts.contacts as never);
    },

    markAddressUsed: async (contactId, addressId) => {
      set((state) => {
        const contact = state.contacts.contacts.find((c) => c.id === contactId);
        if (contact) {
          const addr = contact.addresses.find((a) => a.id === addressId);
          if (addr) {
            addr.lastUsedAt = Date.now();
          }
        }
      });

      await local.set('contacts' as keyof LocalStorageState, get().contacts.contacts as never);
    },

    findByAddress: (address) => {
      const normalized = address.toLowerCase();
      for (const contact of get().contacts.contacts) {
        const addr = contact.addresses.find((a) => a.address.toLowerCase() === normalized);
        if (addr) {
          return { contact, address: addr };
        }
      }
      return undefined;
    },

    getAddressesByNetwork: (network) => {
      const results: Array<{ contact: Contact; address: ContactAddress }> = [];
      for (const contact of get().contacts.contacts) {
        for (const addr of contact.addresses) {
          if (addr.network === network) {
            results.push({ contact, address: addr });
          }
        }
      }
      return results;
    },

    getFavorites: () => {
      return get().contacts.contacts.filter((c) => c.favorite);
    },

    getRecentAddresses: (limit = 5) => {
      const results: Array<{ contact: Contact; address: ContactAddress; lastUsed: number }> = [];
      for (const contact of get().contacts.contacts) {
        for (const addr of contact.addresses) {
          if (addr.lastUsedAt) {
            results.push({ contact, address: addr, lastUsed: addr.lastUsedAt });
          }
        }
      }
      return results
        .sort((a, b) => b.lastUsed - a.lastUsed)
        .slice(0, limit)
        .map(({ contact, address }) => ({ contact, address }));
    },

    search: (query) => {
      const q = query.toLowerCase();
      return get().contacts.contacts.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.notes?.toLowerCase().includes(q) ||
          c.addresses.some(
            (a) =>
              a.address.toLowerCase().includes(q) ||
              a.notes?.toLowerCase().includes(q)
          )
      );
    },

    exportContacts: () => {
      const contacts = get().contacts.contacts;
      return {
        version: 2,
        exportedAt: Date.now(),
        contacts: contacts.map((c) => ({
          name: c.name,
          notes: c.notes,
          favorite: c.favorite,
          addresses: c.addresses.map((a) => ({
            network: a.network,
            address: a.address,
            chainId: a.chainId,
            notes: a.notes,
          })),
        })),
      };
    },

    importContacts: async (data, mode) => {
      if (data.version !== 2) {
        throw new Error('unsupported contacts export version');
      }

      const existingNames = new Set(
        get().contacts.contacts.map((c) => c.name.toLowerCase())
      );

      const newContacts: Contact[] = data.contacts
        .filter((c) => mode === 'replace' || !existingNames.has(c.name.toLowerCase()))
        .map((c) => ({
          id: generateId(),
          name: c.name,
          notes: c.notes,
          favorite: c.favorite,
          createdAt: Date.now(),
          addresses: c.addresses.map((a) => ({
            id: generateId(),
            network: a.network,
            address: a.address,
            chainId: a.chainId,
            notes: a.notes,
          })),
        }));

      set((state) => {
        if (mode === 'replace') {
          state.contacts.contacts = newContacts;
        } else {
          state.contacts.contacts.push(...newContacts);
        }
      });

      await local.set('contacts' as keyof LocalStorageState, get().contacts.contacts as never);
      return newContacts.length;
    },

    clearAll: async () => {
      set((state) => {
        state.contacts.contacts = [];
      });
      await local.set('contacts' as keyof LocalStorageState, [] as never);
    },
  });

// selectors
export const contactsSelector = (state: AllSlices) => state.contacts;
export const allContactsSelector = (state: AllSlices) => state.contacts.contacts;
export const favoriteContactsSelector = (state: AllSlices) => state.contacts.getFavorites();
