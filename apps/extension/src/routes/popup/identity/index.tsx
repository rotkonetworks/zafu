/**
 * identity — your zid, connected sites, permissions, share log.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo } from '../../../state/keyring';
import { allContactsSelector } from '../../../state/contacts';
import { localExtStorage } from '@repo/storage-chrome/local';
import type { ZidSitePreference, ZidShareRecord } from '../../../state/identity';
import { getOriginPermissions, grantCapability, denyCapability } from '@repo/storage-chrome/origin';
import { revokeOrigin as revokeOriginFull } from '../../../senders/revoke';
import { CAPABILITY_META, type Capability, type OriginPermissions } from '@repo/storage-chrome/capabilities';
import { SettingsScreen } from '../settings/settings-screen';
import { PopupPath } from '../paths';

interface SiteIdentity {
  origin: string;
  pref: ZidSitePreference;
  shares: ZidShareRecord[];
  lastShared?: ZidShareRecord;
  label?: string;
  connected: boolean;
  perms?: OriginPermissions;
}

type ActiveTab = 'sites' | 'log';

const shortDate = (ms: number): string => {
  const d = new Date(ms);
  const diff = Date.now() - ms;
  if (diff < 86400000) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (diff < 604800000) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const displayOrigin = (origin: string): string =>
  origin.replace(/^https?:\/\//, '').replace(/\/$/, '');

export const IdentityPage = () => {
  const navigate = useNavigate();
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const contacts = useStore(allContactsSelector);
  const [copied, setCopied] = useState<string | null>(null);
  const [sites, setSites] = useState<SiteIdentity[]>([]);
  const [shareLog, setShareLog] = useState<ZidShareRecord[]>([]);
  const [siteLabels, setSiteLabels] = useState<Record<string, string>>({});
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [labelInput, setLabelInput] = useState('');
  const [activeTab, setActiveTab] = useState<ActiveTab>('sites');
  const [expandedSite, setExpandedSite] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ origin: string; action: 'cross-site' | 'rotate' } | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const reloadSites = useCallback(() => setReloadKey(k => k + 1), []);

  const zidPubkey = keyInfo?.insensitive?.['zid'] as string | undefined;
  const zidAddress = zidPubkey ? 'zid' + zidPubkey.slice(0, 16) : undefined;

  useEffect(() => {
    void (async () => {
      const [prefs, log, labels, knownSitesRaw] = await Promise.all([
        localExtStorage.get('zidPreferences') as Promise<Record<string, ZidSitePreference> | undefined>,
        localExtStorage.get('zidShareLog') as Promise<ZidShareRecord[] | undefined>,
        localExtStorage.get('zidSiteLabels') as Promise<Record<string, string> | undefined>,
        localExtStorage.get('knownSites') as Promise<{ origin: string; choice: string }[] | undefined>,
      ]);

      setSiteLabels(labels ?? {});
      setShareLog(log ?? []);

      const approvedOrigins = new Set<string>();
      if (Array.isArray(knownSitesRaw)) {
        for (const s of knownSitesRaw) {
          if (s.choice === 'Approved') approvedOrigins.add(s.origin);
        }
      }

      const allOrigins = new Set<string>();
      if (prefs) Object.keys(prefs).forEach(o => allOrigins.add(o));
      if (log) log.forEach(r => allOrigins.add(r.sharedWith));

      const siteList: SiteIdentity[] = [];
      for (const origin of allOrigins) {
        const pref = prefs?.[origin] ?? { mode: 'site' as const, rotation: 0, identity: 'default' };
        const shares = log?.filter(r => r.sharedWith === origin) ?? [];
        const lastShared = shares[shares.length - 1];
        const connected = approvedOrigins.has(origin);
        const perms = await getOriginPermissions(origin);
        siteList.push({ origin, pref, shares, lastShared, label: labels?.[origin], connected, perms });
      }

      siteList.sort((a, b) => {
        if (a.connected !== b.connected) return a.connected ? -1 : 1;
        return (b.lastShared?.sharedAt ?? 0) - (a.lastShared?.sharedAt ?? 0);
      });

      setSites(siteList);
    })();
  }, [reloadKey]);

  const copy = useCallback((text: string, which: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(which);
    setTimeout(() => setCopied(null), 1500);
  }, []);

  const saveLabel = useCallback(async (origin: string, label: string) => {
    const labels = (await localExtStorage.get('zidSiteLabels') as Record<string, string>) ?? {};
    if (label.trim()) { labels[origin] = label.trim(); } else { delete labels[origin]; }
    await localExtStorage.set('zidSiteLabels', labels);
    setSiteLabels(labels);
    setEditingLabel(null);
  }, []);

  const updatePref = useCallback(async (origin: string, next: ZidSitePreference | undefined) => {
    const prefs = (await localExtStorage.get('zidPreferences') as Record<string, ZidSitePreference>) ?? {};
    if (next) { prefs[origin] = next; } else { delete prefs[origin]; }
    await localExtStorage.set('zidPreferences', prefs);
    setSites(prev => prev.map(s =>
      s.origin === origin ? { ...s, pref: next ?? { mode: 'site', rotation: 0, identity: 'default' } } : s
    ));
    setConfirming(null);
  }, []);

  const crossSiteCount = useMemo(() => sites.filter(s => s.pref.mode === 'cross-site').length, [sites]);
  const contactCount = contacts?.length ?? 0;

  if (!zidPubkey) {
    return (
      <SettingsScreen title='identity' backPath={PopupPath.INDEX}>
        <div className='flex min-h-60 flex-col items-center justify-center'>
          <p className='text-sm text-muted-foreground'>no zid available</p>
          <p className='mt-2 text-xs text-muted-foreground/50'>create a wallet to get started.</p>
        </div>
      </SettingsScreen>
    );
  }

  return (
    <SettingsScreen title='identity' backPath={PopupPath.INDEX}>
      <div className='flex flex-col gap-5'>

        {/* ── zid ── */}
        <section>
          <button onClick={() => copy(zidPubkey, 'zid')} className='w-full text-left'>
            <div className='font-mono text-sm'>{zidAddress}</div>
            <div className='font-mono text-[9px] text-muted-foreground/60 mt-1 break-all leading-relaxed'>{zidPubkey}</div>
            <div className='text-[10px] text-muted-foreground/40 mt-2'>
              {copied === 'zid' ? 'copied' : 'tap to copy'}
            </div>
          </button>

          {showQr && (
            <div className='mt-3 flex justify-center'>
              <div className='bg-white p-2'><QrCanvas data={zidPubkey} size={140} /></div>
            </div>
          )}

          <div className='flex items-center gap-4 mt-3 text-[10px] text-muted-foreground/40 font-mono'>
            <button onClick={() => setShowQr(!showQr)} className='hover:text-muted-foreground'>
              {showQr ? 'hide qr' : 'show qr'}
            </button>
            <span>{sites.length} sites</span>
            <span>{contactCount} contacts</span>
            {crossSiteCount > 0 && <span>{crossSiteCount} linkable</span>}
          </div>
        </section>

        <hr className='border-border/40' />

        {/* ── tabs ── */}
        <div className='flex gap-4 text-xs font-mono'>
          <button
            onClick={() => setActiveTab('sites')}
            className={activeTab === 'sites' ? 'text-foreground' : 'text-muted-foreground/40 hover:text-muted-foreground'}
          >
            sites ({sites.length})
          </button>
          <button
            onClick={() => setActiveTab('log')}
            className={activeTab === 'log' ? 'text-foreground' : 'text-muted-foreground/40 hover:text-muted-foreground'}
          >
            log ({shareLog.length})
          </button>
        </div>

        {/* ── sites ── */}
        {activeTab === 'sites' && (
          <section className='flex flex-col gap-1'>
            {sites.length === 0 ? (
              <p className='text-xs text-muted-foreground/40 py-4'>no sites yet.</p>
            ) : (
              sites.map(site => (
                <SiteRow
                  key={site.origin}
                  site={site}
                  siteLabels={siteLabels}
                  editingLabel={editingLabel}
                  labelInput={labelInput}
                  setEditingLabel={setEditingLabel}
                  setLabelInput={setLabelInput}
                  saveLabel={saveLabel}
                  expanded={expandedSite === site.origin}
                  onToggleExpand={() => setExpandedSite(expandedSite === site.origin ? null : site.origin)}
                  confirming={confirming?.origin === site.origin ? confirming.action : null}
                  onConfirm={(action) => setConfirming({ origin: site.origin, action })}
                  onCancelConfirm={() => setConfirming(null)}
                  onUpdatePref={updatePref}
                  onSitesChanged={reloadSites}
                  copied={copied}
                  onCopy={copy}
                />
              ))
            )}
          </section>
        )}

        {/* ── log ── */}
        {activeTab === 'log' && (
          <section className='flex flex-col gap-0'>
            {shareLog.length === 0 ? (
              <p className='text-xs text-muted-foreground/40 py-4'>no keys shared yet.</p>
            ) : (
              [...shareLog].reverse().map((record, i) => (
                <button
                  key={`${record.sharedWith}-${record.sharedAt}-${i}`}
                  onClick={() => copy(record.publicKey, `log-${i}`)}
                  className='flex items-baseline justify-between gap-2 py-1.5 text-left border-b border-border/30 last:border-0'
                >
                  <span className='text-[10px] font-mono truncate'>
                    {displayOrigin(record.sharedWith)}
                  </span>
                  <span className='text-[9px] text-muted-foreground/60 shrink-0 font-mono'>
                    {copied === `log-${i}` ? 'copied' : shortDate(record.sharedAt)}
                  </span>
                </button>
              ))
            )}
          </section>
        )}

        <hr className='border-border/40' />

        {/* ── links ── */}
        <div className='flex flex-col gap-2'>
          <button
            onClick={() => navigate(PopupPath.CONTACTS)}
            className='flex items-baseline justify-between text-xs font-mono text-muted-foreground/50 hover:text-muted-foreground'
          >
            <span>contacts</span>
            <span>{contactCount} &rarr;</span>
          </button>
          <button
            onClick={() => navigate(PopupPath.PASSWORDS)}
            className='flex items-baseline justify-between text-xs font-mono text-muted-foreground/50 hover:text-muted-foreground'
          >
            <span>passwords</span>
            <span>&rarr;</span>
          </button>
        </div>

        {keyInfo && (
          <div className='text-[9px] text-muted-foreground/50 font-mono'>{keyInfo.name}</div>
        )}
      </div>
    </SettingsScreen>
  );
};

/* ── qr ── */
const QrCanvas = ({ data, size }: { data: string; size: number }) => {
  const ref = useCallback((canvas: HTMLCanvasElement | null) => {
    if (!canvas || !data) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const QRCode = require('qrcode');
      QRCode.toCanvas(canvas, data, { width: size, margin: 1, color: { dark: '#000', light: '#fff' }, errorCorrectionLevel: 'L' });
    } catch { /* */ }
  }, [data, size]);
  return <canvas ref={ref} />;
};

/* ── site row ── */
const ALL_CAPS: Capability[] = ['connect', 'sign_identity', 'send_tx', 'export_fvk', 'view_contacts', 'view_history', 'frost', 'auto_sign'];

const SiteRow = ({
  site, siteLabels, editingLabel, labelInput,
  setEditingLabel, setLabelInput, saveLabel,
  expanded, onToggleExpand,
  confirming, onConfirm, onCancelConfirm, onUpdatePref, onSitesChanged,
  copied, onCopy,
}: {
  site: SiteIdentity;
  siteLabels: Record<string, string>;
  editingLabel: string | null;
  labelInput: string;
  setEditingLabel: (origin: string | null) => void;
  setLabelInput: (val: string) => void;
  saveLabel: (origin: string, label: string) => Promise<void>;
  expanded: boolean;
  onToggleExpand: () => void;
  confirming: 'cross-site' | 'rotate' | null;
  onConfirm: (action: 'cross-site' | 'rotate') => void;
  onCancelConfirm: () => void;
  onUpdatePref: (origin: string, pref: ZidSitePreference | undefined) => Promise<void>;
  onSitesChanged: () => void;
  copied: string | null;
  onCopy: (text: string, which: string) => void;
}) => {
  const isSiteMode = site.pref.mode === 'site';
  const rotation = site.pref.rotation;
  const [capsOpen, setCapsOpen] = useState(false);

  const handleCapToggle = async (cap: Capability, enabled: boolean) => {
    if (enabled) await grantCapability(site.origin, cap);
    else await denyCapability(site.origin, cap);
    onSitesChanged();
  };

  const handleRevoke = () => {
    revokeOriginFull(site.origin); // kills sessions + deletes permissions
    onSitesChanged();
  };

  return (
    <div className={`border-b border-border/30 last:border-0 ${!site.connected ? 'opacity-40' : ''}`}>
      {/* header */}
      <button onClick={onToggleExpand} className='w-full flex items-baseline justify-between py-2 text-left'>
        <div className='flex items-baseline gap-2 min-w-0'>
          {editingLabel === site.origin ? (
            <input
              autoFocus
              value={labelInput}
              onChange={e => setLabelInput(e.target.value)}
              onBlur={() => void saveLabel(site.origin, labelInput)}
              onClick={e => e.stopPropagation()}
              onKeyDown={e => { if (e.key === 'Enter') void saveLabel(site.origin, labelInput); if (e.key === 'Escape') setEditingLabel(null); }}
              className='text-xs font-mono bg-transparent border-b border-muted-foreground/40 outline-none'
              placeholder='label...'
            />
          ) : (
            <span className='text-xs font-mono truncate'>
              {siteLabels[site.origin] || displayOrigin(site.origin)}
            </span>
          )}
          {!isSiteMode && <span className='text-[8px] text-muted-foreground/60 font-mono'>cross</span>}
        </div>
        <span className='text-[9px] text-muted-foreground/60 font-mono shrink-0'>
          {site.perms ? `${site.perms.granted.length} caps` : ''}
          {isSiteMode && rotation > 0 ? ` #${rotation}` : ''}
        </span>
      </button>

      {/* expanded */}
      {expanded && (
        <div className='pb-3 pl-2 flex flex-col gap-2 text-[10px] font-mono'>
          {/* last shared */}
          {site.lastShared && (
            <button onClick={() => onCopy(site.lastShared!.publicKey, site.origin)} className='text-left text-muted-foreground/40 hover:text-muted-foreground truncate'>
              {copied === site.origin ? 'copied' : site.lastShared.publicKey.slice(0, 40) + '...'}
            </button>
          )}

          {/* identity mode */}
          <div className='flex flex-col gap-1'>
            <div className='flex items-center gap-0'>
              <button
                onClick={() => !isSiteMode ? void onUpdatePref(site.origin, undefined) : undefined}
                className={`px-2 py-0.5 rounded-l border text-[10px] transition-colors ${
                  isSiteMode
                    ? 'bg-green-500/15 border-green-500/30 text-green-400'
                    : 'border-border/40 text-muted-foreground/40 hover:text-muted-foreground'
                }`}
              >
                unique key
              </button>
              <button
                onClick={() => isSiteMode ? onConfirm('cross-site') : undefined}
                className={`px-2 py-0.5 rounded-r border border-l-0 text-[10px] transition-colors ${
                  !isSiteMode
                    ? 'bg-yellow-500/15 border-yellow-500/30 text-yellow-400'
                    : 'border-border/40 text-muted-foreground/40 hover:text-muted-foreground'
                }`}
              >
                shared key
              </button>
            </div>
            {!isSiteMode && (
              <span className='text-muted-foreground/60'>sites with shared key can link your sessions</span>
            )}
          </div>

          {/* actions */}
          <div className='flex items-center gap-3 text-muted-foreground/50'>
            {isSiteMode && (
              <div className='flex items-center gap-1.5'>
                <span className='text-muted-foreground/60'>rotation:</span>
                <button
                  onClick={() => rotation > 0 ? void onUpdatePref(site.origin, { ...site.pref, rotation: rotation - 1 }) : undefined}
                  disabled={rotation === 0}
                  className='hover:text-muted-foreground disabled:opacity-20'
                >
                  <span className='i-lucide-minus size-3' />
                </button>
                <input
                  type='number'
                  min={0}
                  value={rotation}
                  onChange={e => {
                    const v = Math.max(0, parseInt(e.target.value, 10) || 0);
                    void onUpdatePref(site.origin, { ...site.pref, rotation: v });
                  }}
                  className='w-8 bg-transparent border border-border/40 rounded text-center text-[10px] font-mono py-0.5 outline-none'
                />
                <button
                  onClick={() => onConfirm('rotate')}
                  className='hover:text-muted-foreground'
                >
                  <span className='i-lucide-plus size-3' />
                </button>
              </div>
            )}
            <button
              onClick={() => { setEditingLabel(site.origin); setLabelInput(siteLabels[site.origin] ?? ''); }}
              className='hover:text-muted-foreground'
            >
              label
            </button>
          </div>

          {/* capabilities */}
          {site.perms && (
            <>
              <button onClick={() => setCapsOpen(!capsOpen)} className='text-muted-foreground/40 hover:text-muted-foreground text-left'>
                {capsOpen ? 'hide' : 'show'} permissions
              </button>
              {capsOpen && (
                <div className='flex flex-col gap-0.5 pl-2'>
                  {ALL_CAPS.map(cap => (
                    <label key={cap} className='flex items-center justify-between py-0.5 text-muted-foreground/50'>
                      <span>{CAPABILITY_META[cap].label.toLowerCase()}</span>
                      <input
                        type='checkbox'
                        checked={site.perms!.granted.includes(cap)}
                        onChange={e => void handleCapToggle(cap, e.target.checked)}
                        className='h-3 w-3'
                      />
                    </label>
                  ))}
                </div>
              )}
            </>
          )}

          {/* revoke */}
          <button onClick={() => void handleRevoke()} className='text-muted-foreground/60 hover:text-muted-foreground text-left'>
            revoke
          </button>

          {/* confirmations */}
          {confirming === 'cross-site' && (
            <div className='pl-2 border-l border-muted-foreground/10'>
              <p className='text-muted-foreground/40 mb-1'>same key across all origins. linkable.</p>
              <div className='flex gap-2'>
                <button onClick={onCancelConfirm} className='text-muted-foreground/40 hover:text-muted-foreground'>cancel</button>
                <button
                  onClick={() => void onUpdatePref(site.origin, { mode: 'cross-site', rotation: 0, identity: site.pref.identity })}
                  className='text-muted-foreground hover:text-foreground'
                >confirm</button>
              </div>
            </div>
          )}
          {confirming === 'rotate' && (
            <div className='pl-2 border-l border-muted-foreground/10'>
              <p className='text-muted-foreground/40 mb-1'>new key #{rotation + 1}. site keeps old key.</p>
              <div className='flex gap-2'>
                <button onClick={onCancelConfirm} className='text-muted-foreground/40 hover:text-muted-foreground'>cancel</button>
                <button
                  onClick={() => void onUpdatePref(site.origin, { mode: 'site', rotation: rotation + 1, identity: site.pref.identity })}
                  className='text-muted-foreground hover:text-foreground'
                >rotate</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
