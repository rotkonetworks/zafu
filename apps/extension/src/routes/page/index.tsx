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
  resolveDiscordUrl,
  type Zapp,
  type ZappCategory,
} from './zapps';

export const pageIndexLoader = async () => {
  const vaults = await localExtStorage.get('vaults');
  if (!vaults?.length) {
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
  // active network drives which community Discord the chat zapp opens
  const [activeNetwork, setActiveNetwork] = useState<string | undefined>();

  // load custom zapps + active network from storage
  useEffect(() => {
    chrome.storage.local.get([STORAGE_KEY, 'activeNetwork'], r => {
      if (Array.isArray(r[STORAGE_KEY])) {
        setCustomZapps(r[STORAGE_KEY]);
      }
      if (typeof r['activeNetwork'] === 'string') {
        setActiveNetwork(r['activeNetwork']);
      }
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
    if (!draft.name || !draft.url) {
      return;
    }
    const zapp: Zapp = {
      id: `custom-${Date.now()}`,
      name: draft.name,
      description: draft.description || draft.url,
      icon: 'i-ph-puzzle-piece',
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
    if (zapp.url === '__discord__') {
      window.open(resolveDiscordUrl(activeNetwork), '_blank');
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
      <div className='mx-auto flex max-w-2xl flex-col gap-9 px-4 pb-12 pt-10'>
        <div className='flex items-end justify-between border-b border-border-soft/50 pb-6'>
          <div className='flex flex-col gap-2'>
            <h1 className='text-3xl font-semibold lowercase tracking-tight text-fg-high'>zafu</h1>
            <div className='h-px w-8 bg-zigner-gold/70' />
            <p className='text-label lowercase tracking-wide text-fg-muted'>
              apps &amp; integrations
            </p>
          </div>
          <button
            onClick={() => setAdding(!adding)}
            className='flex items-center gap-1.5 rounded-full border border-border-soft bg-elev-1 px-3.5 py-1.5 text-xs text-fg-muted transition-colors hover:border-zigner-gold/40 hover:text-fg-high'
          >
            <span className='i-ph-plus h-3.5 w-3.5' />
            add zapp
          </button>
        </div>

        {adding && (
          <div className='rounded-lg border border-border-soft bg-elev-1 p-4 flex flex-col gap-3'>
            <input
              value={draft.name}
              onChange={e => setDraft({ ...draft, name: e.target.value })}
              placeholder='name'
              className='w-full bg-input border border-border-soft px-3 py-2 text-sm rounded-lg focus:outline-none focus:border-zigner-gold'
            />
            <input
              value={draft.url}
              onChange={e => setDraft({ ...draft, url: e.target.value })}
              placeholder='https://...'
              className='w-full bg-input border border-border-soft px-3 py-2 text-sm rounded-lg focus:outline-none focus:border-zigner-gold'
            />
            <input
              value={draft.description}
              onChange={e => setDraft({ ...draft, description: e.target.value })}
              placeholder='description (optional)'
              className='w-full bg-input border border-border-soft px-3 py-2 text-sm rounded-lg focus:outline-none focus:border-zigner-gold'
            />
            <div className='flex gap-2'>
              <button
                onClick={() => setAdding(false)}
                className='flex-1 rounded-lg border border-border-soft py-2 text-xs hover:bg-elev-1 transition-colors'
              >
                cancel
              </button>
              <button
                onClick={handleAdd}
                disabled={!draft.name || !draft.url}
                className='flex-1 rounded-lg bg-primary/15 text-zigner-gold border border-primary/25 py-2 text-xs hover:bg-primary/25 transition-colors disabled:opacity-50'
              >
                add
              </button>
            </div>
          </div>
        )}

        {grouped.map(([category, zapps]) => (
          <div key={category} className='flex flex-col gap-3'>
            <div className='flex items-center gap-3'>
              <h2 className='text-label font-semibold uppercase tracking-wider text-fg-muted'>
                {CATEGORY_LABELS[category]}
              </h2>
              <div className='h-px flex-1 bg-border-soft/60' />
            </div>
            <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
              {zapps.map(zapp => (
                <div key={zapp.id} className='group relative'>
                  <button
                    onClick={() => handleClick(zapp)}
                    className='flex w-full items-center gap-3 rounded-xl border border-border-soft bg-elev-1 p-3 text-left transition-all duration-150 hover:-translate-y-0.5 hover:border-zigner-gold/40 hover:bg-elev-2 hover:shadow-lg hover:shadow-black/20'
                  >
                    <span className='flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-elev-2 transition-colors group-hover:bg-zigner-gold/10'>
                      <span
                        className={`${zapp.icon} h-5 w-5 text-fg-muted transition-colors group-hover:text-zigner-gold`}
                      />
                    </span>
                    <span className='flex min-w-0 flex-col'>
                      <span className='truncate text-sm font-medium text-fg-high'>{zapp.name}</span>
                      <span className='truncate text-label text-fg-muted' title={zapp.description}>
                        {zapp.description}
                      </span>
                    </span>
                    <span className='i-ph-arrow-up-right ml-auto h-4 w-4 shrink-0 text-fg-dim opacity-0 transition-opacity group-hover:opacity-100' />
                  </button>
                  {!zapp.builtin && (
                    <button
                      onClick={() => handleRemove(zapp.id)}
                      className='absolute -right-1.5 -top-1.5 hidden h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-sm group-hover:flex'
                      title='remove zapp'
                    >
                      <span className='i-ph-x h-3 w-3' />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}

        <div className='pt-2 text-center text-label text-fg-muted/40'>MIT - rotko networks</div>
      </div>
    </FadeTransition>
  );
};
