import { useState, useEffect, useMemo } from 'react';
import { redirect } from 'react-router-dom';
import { PagePath } from './paths';
import { localExtStorage } from '@repo/storage-chrome/local';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import {
  DEFAULT_ZAPPS,
  CATEGORY_LABELS,
  categoryOrder,
  resolveZappUrl,
  type Zapp,
  type ZappCategory,
} from './zapps';

export const pageIndexLoader = async () => {
  const vaults = await localExtStorage.get('vaults');
  if (!vaults || !vaults.length) {
    return redirect(PagePath.WELCOME);
  }
  return null;
};

const openSidePanel = async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch {
    await chrome.windows.create({
      url: chrome.runtime.getURL('popup.html'),
      type: 'popup',
      width: 400,
      height: 628,
    });
  }
};

const STORAGE_KEY = 'customZapps';

export const PageIndex = () => {
  const [customZapps, setCustomZapps] = useState<Zapp[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', url: '', description: '' });

  // load custom zapps from storage
  useEffect(() => {
    chrome.storage.local.get(STORAGE_KEY, r => {
      if (Array.isArray(r[STORAGE_KEY])) setCustomZapps(r[STORAGE_KEY]);
    });
  }, []);

  const allZapps = useMemo(() => [...DEFAULT_ZAPPS, ...customZapps], [customZapps]);

  const grouped = useMemo(() => {
    const map = new Map<ZappCategory, Zapp[]>();
    for (const z of allZapps) {
      const list = map.get(z.category) ?? [];
      list.push(z);
      map.set(z.category, list);
    }
    return [...map.entries()].sort((a, b) => categoryOrder(a[0], b[0]));
  }, [allZapps]);

  const handleAdd = () => {
    if (!draft.name || !draft.url) return;
    const zapp: Zapp = {
      id: `custom-${Date.now()}`,
      name: draft.name,
      description: draft.description || draft.url,
      icon: 'i-lucide-puzzle',
      url: draft.url,
      category: 'tools',
    };
    const updated = [...customZapps, zapp];
    setCustomZapps(updated);
    void chrome.storage.local.set({ [STORAGE_KEY]: updated });
    setDraft({ name: '', url: '', description: '' });
    setAdding(false);
  };

  const handleRemove = (id: string) => {
    const updated = customZapps.filter(z => z.id !== id);
    setCustomZapps(updated);
    void chrome.storage.local.set({ [STORAGE_KEY]: updated });
  };

  const handleClick = (zapp: Zapp) => {
    if (zapp.url === '__sidepanel__') {
      void openSidePanel();
      return;
    }
    const resolved = resolveZappUrl(zapp.url);
    if (resolved) {
      if (resolved.startsWith('chrome-extension://')) {
        window.location.href = resolved;
      } else {
        window.open(resolved, '_blank');
      }
    }
  };

  return (
    <FadeTransition>
      <div className='flex flex-col gap-6 max-w-2xl mx-auto pt-8 px-4'>
        <div className='flex items-center justify-between'>
          <h1 className='text-xl font-medium'>zafu</h1>
          <button
            onClick={() => setAdding(!adding)}
            className='flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors'
          >
            <span className='i-lucide-plus h-3.5 w-3.5' />
            add zapp
          </button>
        </div>

        {adding && (
          <div className='rounded-lg border border-border/40 bg-card p-4 flex flex-col gap-3'>
            <input
              value={draft.name}
              onChange={e => setDraft({ ...draft, name: e.target.value })}
              placeholder='name'
              className='w-full bg-input border border-border/40 px-3 py-2 text-sm rounded-lg focus:outline-none focus:border-primary'
            />
            <input
              value={draft.url}
              onChange={e => setDraft({ ...draft, url: e.target.value })}
              placeholder='https://...'
              className='w-full bg-input border border-border/40 px-3 py-2 text-sm rounded-lg focus:outline-none focus:border-primary'
            />
            <input
              value={draft.description}
              onChange={e => setDraft({ ...draft, description: e.target.value })}
              placeholder='description (optional)'
              className='w-full bg-input border border-border/40 px-3 py-2 text-sm rounded-lg focus:outline-none focus:border-primary'
            />
            <div className='flex gap-2'>
              <button
                onClick={() => setAdding(false)}
                className='flex-1 rounded-lg border border-border/40 py-2 text-xs hover:bg-muted/50 transition-colors'
              >
                cancel
              </button>
              <button
                onClick={handleAdd}
                disabled={!draft.name || !draft.url}
                className='flex-1 rounded-lg bg-primary/15 text-primary border border-primary/25 py-2 text-xs hover:bg-primary/25 transition-colors disabled:opacity-50'
              >
                add
              </button>
            </div>
          </div>
        )}

        {grouped.map(([category, zapps]) => (
          <div key={category}>
            <h2 className='text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2'>
              {CATEGORY_LABELS[category]}
            </h2>
            <div className='grid grid-cols-3 gap-3'>
              {zapps.map(zapp => (
                <div key={zapp.id} className='group relative'>
                  <button
                    onClick={() => handleClick(zapp)}
                    className='w-full flex flex-col items-center gap-2 rounded-lg border border-border/40 bg-card p-4 hover:bg-muted/50 transition-colors'
                  >
                    <span className={`${zapp.icon} h-6 w-6 text-muted-foreground`} />
                    <span className='text-xs font-medium'>{zapp.name}</span>
                    <span className='text-[10px] text-muted-foreground/60'>{zapp.description}</span>
                  </button>
                  {!zapp.builtin && (
                    <button
                      onClick={() => handleRemove(zapp.id)}
                      className='absolute -top-1 -right-1 hidden group-hover:flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground text-xs'
                    >
                      <span className='i-lucide-x h-3 w-3' />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}

        <div className='text-[10px] text-muted-foreground/40 text-center pb-4'>
          GPL-3.0 - rotko networks
        </div>
      </div>
    </FadeTransition>
  );
};
