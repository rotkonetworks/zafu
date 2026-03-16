/**
 * recipient picker — search-first dropdown
 *
 * single input field. on focus, shows categorized dropdown:
 * my wallets → recent → contacts. typing filters all categories.
 * scales to 1000+ contacts via filtering + virtualized max.
 */

import { useState, useMemo, useRef, useEffect } from 'react';
import { useStore } from '../state';
import { contactsSelector, type ContactNetwork } from '../state/contacts';
import { recentAddressesSelector, type AddressNetwork } from '../state/recent-addresses';
import { selectKeyInfos, selectEffectiveKeyInfo } from '../state/keyring';
import { selectZcashWallets } from '../state/wallets';
import { cn } from '@repo/ui/lib/utils';

const MAX_RESULTS = 8;

interface PickerEntry {
  label: string;
  address: string;
  category: 'wallet' | 'recent' | 'contact';
}

interface RecipientPickerProps {
  network: ContactNetwork & AddressNetwork;
  onSelect: (address: string) => void;
  show: boolean;
}

export function RecipientPicker({ network, onSelect, show }: RecipientPickerProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { getRecent } = useStore(recentAddressesSelector);
  const { contacts, findByAddress } = useStore(contactsSelector);
  const keyInfos = useStore(selectKeyInfos);
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const zcashWallets = useStore(selectZcashWallets);

  // build flat entry list from all sources
  const allEntries = useMemo(() => {
    const entries: PickerEntry[] = [];

    // own wallets (other vaults)
    if (network === 'zcash') {
      for (const w of zcashWallets) {
        if (!w.address || w.vaultId === selectedKeyInfo?.id) continue;
        const vault = keyInfos.find(k => k.id === w.vaultId);
        entries.push({ label: vault?.name ?? w.label, address: w.address, category: 'wallet' });
      }
    }

    // recent addresses
    const recent = getRecent(network, 10);
    for (const r of recent) {
      if (entries.some(e => e.address === r.address)) continue;
      const contact = findByAddress(r.address);
      entries.push({
        label: contact ? contact.contact.name : `${r.address.slice(0, 10)}...${r.address.slice(-6)}`,
        address: r.address,
        category: 'recent',
      });
    }

    // contacts
    for (const c of contacts) {
      for (const addr of c.addresses) {
        if (addr.network !== network) continue;
        if (entries.some(e => e.address === addr.address)) continue;
        entries.push({ label: c.name, address: addr.address, category: 'contact' });
      }
    }

    return entries;
  }, [network, zcashWallets, selectedKeyInfo?.id, keyInfos, getRecent, contacts, findByAddress]);

  // filter by query
  const filtered = useMemo(() => {
    if (!query.trim()) return allEntries.slice(0, MAX_RESULTS);
    const q = query.toLowerCase();
    return allEntries
      .filter(e => e.label.toLowerCase().includes(q) || e.address.toLowerCase().includes(q))
      .slice(0, MAX_RESULTS);
  }, [allEntries, query]);

  // close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  if (!show || allEntries.length === 0) return null;

  const categoryIcon: Record<string, string> = {
    wallet: 'i-lucide-wallet',
    recent: 'i-lucide-clock',
    contact: 'i-lucide-user',
  };

  return (
    <div ref={wrapperRef} className='relative mt-2'>
      {/* search input */}
      <div className='relative'>
        <span className='i-lucide-search absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground' />
        <input
          ref={inputRef}
          type='text'
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder={`search ${allEntries.length} address${allEntries.length === 1 ? '' : 'es'}...`}
          className='w-full rounded-lg border border-border/40 bg-input pl-8 pr-3 py-1.5 text-xs focus:border-primary/50 focus:outline-none'
        />
      </div>

      {/* dropdown */}
      {open && filtered.length > 0 && (
        <div className='absolute z-20 left-0 right-0 mt-1 max-h-[240px] overflow-y-auto rounded-lg border border-border/40 bg-card shadow-lg'>
          {filtered.map((entry, i) => {
            const prevCategory = i > 0 ? filtered[i - 1]!.category : null;
            const showHeader = entry.category !== prevCategory;

            return (
              <div key={`${entry.category}-${entry.address}`}>
                {showHeader && (
                  <div className='flex items-center gap-1.5 px-3 pt-2 pb-1'>
                    <span className={cn(categoryIcon[entry.category], 'h-3 w-3 text-muted-foreground')} />
                    <span className='text-[10px] text-muted-foreground uppercase tracking-wider'>
                      {entry.category === 'wallet' ? 'my wallets' : entry.category}
                    </span>
                  </div>
                )}
                <button
                  onClick={() => { onSelect(entry.address); setOpen(false); setQuery(''); }}
                  className='flex w-full flex-col px-3 py-1.5 text-left hover:bg-muted/50 transition-colors'
                >
                  <span className='text-xs truncate'>{entry.label}</span>
                  <span className='text-[10px] font-mono text-muted-foreground truncate'>
                    {entry.address.slice(0, 16)}...{entry.address.slice(-8)}
                  </span>
                </button>
              </div>
            );
          })}
          {query && filtered.length === 0 && (
            <p className='px-3 py-2 text-xs text-muted-foreground'>no matches</p>
          )}
        </div>
      )}
    </div>
  );
}
