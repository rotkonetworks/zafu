/**
 * identity tab — unified view of your ZID, site connections, and contacts.
 *
 * three sections:
 * 1. your zid — primary identity card with pubkey
 * 2. site identities — per-origin keys with rotation history + labels
 * 3. contacts — link to contacts page
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo } from '../../../state/keyring';
import { contactsSelector, type Contact } from '../../../state/contacts';
import { localExtStorage } from '@repo/storage-chrome/local';
import type { ZidSitePreference, ZidShareRecord } from '../../../state/identity';
import { PopupPath } from '../paths';

/** site identity with persisted state */
interface SiteIdentity {
  origin: string;
  pref: ZidSitePreference;
  lastShared?: ZidShareRecord;
  label?: string;
  connected: boolean;
}

export const IdentityPage = () => {
  const navigate = useNavigate();
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const contacts = useStore(contactsSelector);
  const [copied, setCopied] = useState<string | null>(null);
  const [sites, setSites] = useState<SiteIdentity[]>([]);
  const [siteLabels, setSiteLabels] = useState<Record<string, string>>({});
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [labelInput, setLabelInput] = useState('');

  const zidPubkey = keyInfo?.insensitive?.['zid'] as string | undefined;
  const zidAddress = zidPubkey ? 'zid' + zidPubkey.slice(0, 16) : undefined;

  // load site identities from preferences + share log + origin approvals
  useEffect(() => {
    void (async () => {
      const [prefs, shareLog, labels, origins] = await Promise.all([
        localExtStorage.get('zidPreferences') as Promise<Record<string, ZidSitePreference> | undefined>,
        localExtStorage.get('zidShareLog') as Promise<ZidShareRecord[] | undefined>,
        localExtStorage.get('zidSiteLabels') as Promise<Record<string, string> | undefined>,
        localExtStorage.get('connectedSites') as Promise<Record<string, unknown> | undefined>,
      ]);

      setSiteLabels(labels ?? {});

      // collect all known origins from prefs + share log
      const allOrigins = new Set<string>();
      if (prefs) Object.keys(prefs).forEach(o => allOrigins.add(o));
      if (shareLog) shareLog.forEach(r => allOrigins.add(r.sharedWith));

      const siteList: SiteIdentity[] = [];
      for (const origin of allOrigins) {
        const pref = prefs?.[origin] ?? { mode: 'site' as const, rotation: 0, identity: 'default' };
        const shares = shareLog?.filter(r => r.sharedWith === origin) ?? [];
        const lastShared = shares[shares.length - 1];
        // check if origin is currently connected (has approval record)
        const connected = origins ? origin in origins : false;

        siteList.push({
          origin,
          pref,
          lastShared,
          label: labels?.[origin],
          connected,
        });
      }

      // sort: connected first, then by last shared date
      siteList.sort((a, b) => {
        if (a.connected !== b.connected) return a.connected ? -1 : 1;
        const aTime = a.lastShared?.sharedAt ?? 0;
        const bTime = b.lastShared?.sharedAt ?? 0;
        return bTime - aTime;
      });

      setSites(siteList);
    })();
  }, []);

  const copy = (text: string, which: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(which);
    setTimeout(() => setCopied(null), 1500);
  };

  const saveLabel = useCallback(async (origin: string, label: string) => {
    const labels = (await localExtStorage.get('zidSiteLabels') as Record<string, string>) ?? {};
    if (label.trim()) {
      labels[origin] = label.trim();
    } else {
      delete labels[origin];
    }
    await localExtStorage.set('zidSiteLabels', labels);
    setSiteLabels(labels);
    setEditingLabel(null);
  }, []);

  const setRotation = useCallback(async (origin: string, rotation: number) => {
    const prefs = (await localExtStorage.get('zidPreferences') as Record<string, ZidSitePreference>) ?? {};
    const current = prefs[origin] ?? { mode: 'site' as const, rotation: 0, identity: 'default' };
    prefs[origin] = { ...current, rotation };
    await localExtStorage.set('zidPreferences', prefs);
    setSites(prev => prev.map(s =>
      s.origin === origin ? { ...s, pref: { ...s.pref, rotation } } : s
    ));
  }, []);

  if (!zidPubkey) {
    return (
      <div className='flex min-h-full flex-col items-center justify-center p-8'>
        <span className='i-lucide-fingerprint h-10 w-10 text-muted-foreground/30' />
        <p className='mt-4 text-sm text-muted-foreground text-center'>
          no zid available
        </p>
        <p className='mt-1 text-xs text-muted-foreground/60 text-center'>
          create a new wallet to get a zid identity.
        </p>
      </div>
    );
  }

  const contactCount = contacts?.length ?? 0;

  return (
    <div className='flex min-h-full flex-col p-4 gap-5'>
      {/* ─── YOUR ZID ─── */}
      <section>
        <div className='flex items-center gap-2 mb-3'>
          <span className='i-lucide-fingerprint h-4 w-4 text-muted-foreground' />
          <span className='text-xs font-medium text-muted-foreground uppercase tracking-wider'>your zid</span>
        </div>

        <button
          onClick={() => copy(zidPubkey, 'zid')}
          className='w-full rounded-lg border border-border/40 bg-card p-4 text-left hover:bg-muted/50 transition-colors'
        >
          <div className='text-[10px] text-muted-foreground/60 mb-1'>
            {copied === 'zid' ? 'copied' : 'tap to copy'}
          </div>
          <div className='font-mono text-sm'>{zidAddress}</div>
          <div className='font-mono text-[9px] text-muted-foreground/40 mt-1 break-all'>
            {zidPubkey}
          </div>
        </button>
      </section>

      {/* ─── SITE IDENTITIES ─── */}
      <section>
        <div className='flex items-center gap-2 mb-3'>
          <span className='i-lucide-globe h-4 w-4 text-muted-foreground' />
          <span className='text-xs font-medium text-muted-foreground uppercase tracking-wider'>
            sites ({sites.length})
          </span>
        </div>

        {sites.length === 0 ? (
          <div className='rounded-lg border border-border/40 bg-card p-3 text-xs text-muted-foreground/60'>
            no sites connected yet
          </div>
        ) : (
          <div className='flex flex-col gap-2'>
            {sites.map(site => (
              <div
                key={site.origin}
                className={`rounded-lg border p-3 ${
                  site.connected
                    ? 'border-border/40 bg-card'
                    : 'border-border/20 bg-card/50 opacity-60'
                }`}
              >
                <div className='flex items-center justify-between'>
                  <div className='flex items-center gap-2 min-w-0'>
                    <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${
                      site.connected ? 'bg-green-400' : 'bg-muted-foreground/30'
                    }`} />
                    {editingLabel === site.origin ? (
                      <input
                        autoFocus
                        value={labelInput}
                        onChange={e => setLabelInput(e.target.value)}
                        onBlur={() => void saveLabel(site.origin, labelInput)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') void saveLabel(site.origin, labelInput);
                          if (e.key === 'Escape') setEditingLabel(null);
                        }}
                        className='text-xs bg-transparent border-b border-muted-foreground/30 outline-none w-full'
                        placeholder='label this site...'
                      />
                    ) : (
                      <button
                        onClick={() => {
                          setEditingLabel(site.origin);
                          setLabelInput(siteLabels[site.origin] ?? '');
                        }}
                        className='text-xs font-medium truncate hover:text-foreground text-left'
                        title='click to label'
                      >
                        {siteLabels[site.origin] || site.origin.replace(/^https?:\/\//, '')}
                      </button>
                    )}
                  </div>

                  {/* rotation selector */}
                  <div className='flex items-center gap-1 flex-shrink-0'>
                    <span className='text-[9px] text-muted-foreground/50'>#{site.pref.rotation}</span>
                    {site.pref.rotation > 0 && (
                      <button
                        onClick={() => void setRotation(site.origin, site.pref.rotation - 1)}
                        className='text-[9px] text-muted-foreground hover:text-foreground px-1'
                        title='previous identity'
                      >
                        ‹
                      </button>
                    )}
                    <button
                      onClick={() => void setRotation(site.origin, site.pref.rotation + 1)}
                      className='text-[9px] text-muted-foreground hover:text-foreground px-1'
                      title='rotate to new identity'
                    >
                      ›
                    </button>
                  </div>
                </div>

                {/* last shared info */}
                {site.lastShared && (
                  <div className='mt-1 text-[9px] text-muted-foreground/40'>
                    last used {new Date(site.lastShared.sharedAt).toLocaleDateString()}
                    {' · '}
                    <button
                      onClick={() => copy(site.lastShared!.publicKey, site.origin)}
                      className='hover:text-muted-foreground'
                    >
                      {copied === site.origin ? 'copied' : 'copy pubkey'}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ─── CONTACTS ─── */}
      <section>
        <button
          onClick={() => navigate(PopupPath.CONTACTS)}
          className='w-full flex items-center justify-between rounded-lg border border-border/40 bg-card p-3 hover:bg-muted/50 transition-colors'
        >
          <div className='flex items-center gap-2'>
            <span className='i-lucide-users h-4 w-4 text-muted-foreground' />
            <span className='text-xs font-medium'>contacts</span>
            {contactCount > 0 && (
              <span className='text-[9px] text-muted-foreground/60 bg-muted/50 px-1.5 py-0.5 rounded'>
                {contactCount}
              </span>
            )}
          </div>
          <span className='i-lucide-chevron-right h-4 w-4 text-muted-foreground/40' />
        </button>
      </section>

      {/* vault info */}
      {keyInfo && (
        <div className='text-[10px] text-muted-foreground/30 text-center'>
          {keyInfo.name} · {keyInfo.type}
        </div>
      )}
    </div>
  );
};
