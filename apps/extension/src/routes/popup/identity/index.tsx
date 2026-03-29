/**
 * identity dashboard - unified view of your zid, site connections, share log,
 * and privacy indicators.
 *
 * five sections:
 * 1. your zid - formatted address with copy + QR
 * 2. connected sites - per-origin keys with mode indicators
 * 3. per-site controls - toggle site/cross-site mode, rotate key
 * 4. share log - history of pubkeys shared with sites
 * 5. privacy indicators - visual showing linkability
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo } from '../../../state/keyring';
import { allContactsSelector } from '../../../state/contacts';
import { localExtStorage } from '@repo/storage-chrome/local';
import type { ZidSitePreference, ZidShareRecord } from '../../../state/identity';
import { getOriginPermissions, grantCapability, denyCapability, revokeOrigin as revokeOriginPerms } from '@repo/storage-chrome/origin';
import { CAPABILITY_META, type Capability, type OriginPermissions } from '@repo/storage-chrome/capabilities';
import { cn } from '@repo/ui/lib/utils';
import { SettingsScreen } from '../settings/settings-screen';
import { PopupPath } from '../paths';

/** site identity with persisted state */
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

/** format epoch ms as short date */
const shortDate = (ms: number): string => {
  const d = new Date(ms);
  const now = new Date();
  const diff = now.getTime() - ms;
  // less than 24h: show time
  if (diff < 86400000) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  // less than 7 days: show day name
  if (diff < 604800000) {
    return d.toLocaleDateString(undefined, { weekday: 'short' });
  }
  // otherwise: short date
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/** truncate origin for display */
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

  // load site identities from preferences + share log + known sites
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

      // build set of approved origins
      const approvedOrigins = new Set<string>();
      if (Array.isArray(knownSitesRaw)) {
        for (const s of knownSitesRaw) {
          if (s.choice === 'Approved') approvedOrigins.add(s.origin);
        }
      }

      // collect all known origins from prefs + share log
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

      // sort: connected first, then by last shared date
      siteList.sort((a, b) => {
        if (a.connected !== b.connected) return a.connected ? -1 : 1;
        const aTime = a.lastShared?.sharedAt ?? 0;
        const bTime = b.lastShared?.sharedAt ?? 0;
        return bTime - aTime;
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
    if (label.trim()) {
      labels[origin] = label.trim();
    } else {
      delete labels[origin];
    }
    await localExtStorage.set('zidSiteLabels', labels);
    setSiteLabels(labels);
    setEditingLabel(null);
  }, []);

  const updatePref = useCallback(async (origin: string, next: ZidSitePreference | undefined) => {
    const prefs = (await localExtStorage.get('zidPreferences') as Record<string, ZidSitePreference>) ?? {};
    if (next) {
      prefs[origin] = next;
    } else {
      delete prefs[origin];
    }
    await localExtStorage.set('zidPreferences', prefs);
    setSites(prev => prev.map(s =>
      s.origin === origin ? { ...s, pref: next ?? { mode: 'site', rotation: 0, identity: 'default' } } : s
    ));
    setConfirming(null);
  }, []);

  // count cross-site mode sites for privacy summary
  const crossSiteCount = useMemo(() =>
    sites.filter(s => s.pref.mode === 'cross-site').length,
  [sites]);

  const contactCount = contacts?.length ?? 0;

  if (!zidPubkey) {
    return (
      <SettingsScreen title='identity' backPath={PopupPath.INDEX}>
        <div className='flex min-h-60 flex-col items-center justify-center'>
          <span className='i-lucide-fingerprint h-10 w-10 text-muted-foreground/30' />
          <p className='mt-4 text-sm text-muted-foreground text-center'>
            no zid available
          </p>
          <p className='mt-1 text-xs text-muted-foreground/60 text-center'>
            create a new wallet to get a zid identity.
          </p>
        </div>
      </SettingsScreen>
    );
  }

  return (
    <SettingsScreen title='identity' backPath={PopupPath.INDEX}>
      <div className='flex flex-col gap-4'>

        {/* ---- YOUR ZID ---- */}
        <section className='rounded-lg border border-border/40 bg-card overflow-hidden'>
          <div className='p-4'>
            <div className='flex items-center justify-between mb-3'>
              <div className='flex items-center gap-2'>
                <span className='i-lucide-fingerprint h-4 w-4 text-primary' />
                <span className='text-xs font-medium uppercase tracking-wider text-muted-foreground'>your zid</span>
              </div>
              <button
                onClick={() => setShowQr(!showQr)}
                className='p-1.5 rounded-md hover:bg-muted/50 transition-colors'
                title={showQr ? 'hide QR code' : 'show QR code'}
              >
                <span className={`${showQr ? 'i-lucide-chevron-up' : 'i-lucide-qr-code'} h-4 w-4 text-muted-foreground`} />
              </button>
            </div>

            {/* address display */}
            <button
              onClick={() => copy(zidPubkey, 'zid')}
              className='w-full text-left group'
            >
              <div className='font-mono text-sm tracking-wide'>{zidAddress}</div>
              <div className='font-mono text-[9px] text-muted-foreground/40 mt-1 break-all leading-relaxed'>
                {zidPubkey}
              </div>
              <div className='flex items-center gap-1 mt-2 text-[10px] text-muted-foreground/60 group-hover:text-muted-foreground transition-colors'>
                <span className={`${copied === 'zid' ? 'i-lucide-check' : 'i-lucide-copy'} h-3 w-3`} />
                <span>{copied === 'zid' ? 'copied to clipboard' : 'copy full public key'}</span>
              </div>
            </button>

            {/* QR code (collapsible) */}
            {showQr && (
              <div className='mt-3 flex justify-center'>
                <div className='bg-white p-2 rounded-lg'>
                  <QrCanvas data={zidPubkey} size={160} />
                </div>
              </div>
            )}
          </div>

          {/* privacy summary bar */}
          <div className='border-t border-border/40 px-4 py-2 flex items-center justify-between bg-muted/20'>
            <div className='flex items-center gap-3'>
              <div className='flex items-center gap-1.5 text-[10px] text-muted-foreground'>
                <span className='i-lucide-globe h-3 w-3' />
                <span>{sites.length} site{sites.length !== 1 ? 's' : ''}</span>
              </div>
              <div className='flex items-center gap-1.5 text-[10px] text-muted-foreground'>
                <span className='i-lucide-users h-3 w-3' />
                <span>{contactCount} contact{contactCount !== 1 ? 's' : ''}</span>
              </div>
            </div>
            {crossSiteCount > 0 && (
              <div className='flex items-center gap-1 text-[10px] text-yellow-400'>
                <span className='i-lucide-triangle-alert h-3 w-3' />
                <span>{crossSiteCount} linkable</span>
              </div>
            )}
          </div>
        </section>

        {/* ---- PRIVACY INDICATORS ---- */}
        <section className='flex gap-2'>
          <div className='flex-1 rounded-lg border border-border/40 bg-card p-3'>
            <div className='flex items-center gap-1.5 mb-1'>
              <span className='i-lucide-shield h-3.5 w-3.5 text-green-400' />
              <span className='text-[10px] font-medium text-green-400'>site-specific</span>
            </div>
            <p className='text-[9px] text-muted-foreground/60 leading-relaxed'>
              each site gets a unique key. sites cannot link your activity across origins.
            </p>
          </div>
          <div className='flex-1 rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-3'>
            <div className='flex items-center gap-1.5 mb-1'>
              <span className='i-lucide-link h-3.5 w-3.5 text-yellow-400' />
              <span className='text-[10px] font-medium text-yellow-400'>cross-site</span>
            </div>
            <p className='text-[9px] text-muted-foreground/60 leading-relaxed'>
              same key across all origins. sites can collude to track you.
            </p>
          </div>
        </section>

        {/* ---- TAB SWITCHER ---- */}
        <div className='flex border-b border-border/40'>
          <button
            onClick={() => setActiveTab('sites')}
            className={`flex-1 py-2 text-xs font-medium transition-colors border-b-2 ${
              activeTab === 'sites'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            connected sites ({sites.length})
          </button>
          <button
            onClick={() => setActiveTab('log')}
            className={`flex-1 py-2 text-xs font-medium transition-colors border-b-2 ${
              activeTab === 'log'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            share log ({shareLog.length})
          </button>
        </div>

        {/* ---- CONNECTED SITES TAB ---- */}
        {activeTab === 'sites' && (
          <section className='flex flex-col gap-2'>
            {sites.length === 0 ? (
              <div className='rounded-lg border border-border/40 bg-card p-6 text-center'>
                <span className='i-lucide-globe h-6 w-6 text-muted-foreground/30 mx-auto block' />
                <p className='mt-2 text-xs text-muted-foreground/60'>
                  no sites have requested your identity yet.
                </p>
              </div>
            ) : (
              sites.map(site => (
                <SiteCard
                  key={site.origin}
                  site={site}
                  siteLabels={siteLabels}
                  editingLabel={editingLabel}
                  labelInput={labelInput}
                  setEditingLabel={setEditingLabel}
                  setLabelInput={setLabelInput}
                  saveLabel={saveLabel}
                  expanded={expandedSite === site.origin}
                  onToggleExpand={() => setExpandedSite(
                    expandedSite === site.origin ? null : site.origin
                  )}
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

        {/* ---- SHARE LOG TAB ---- */}
        {activeTab === 'log' && (
          <section className='flex flex-col gap-1'>
            {shareLog.length === 0 ? (
              <div className='rounded-lg border border-border/40 bg-card p-6 text-center'>
                <span className='i-lucide-scroll-text h-6 w-6 text-muted-foreground/30 mx-auto block' />
                <p className='mt-2 text-xs text-muted-foreground/60'>
                  no keys have been shared yet. this log records every time
                  a public key is sent to a site during authentication.
                </p>
              </div>
            ) : (
              <>
                <p className='text-[9px] text-muted-foreground/50 mb-2'>
                  every time you authenticate to a site, the public key you shared is logged here.
                  newest first.
                </p>
                {[...shareLog].reverse().map((record, i) => (
                  <button
                    key={`${record.sharedWith}-${record.sharedAt}-${i}`}
                    onClick={() => copy(record.publicKey, `log-${i}`)}
                    className='flex items-start gap-3 rounded-lg border border-border/40 bg-card p-3 text-left hover:bg-muted/50 transition-colors'
                  >
                    <span className='i-lucide-key-round h-3.5 w-3.5 text-muted-foreground/50 mt-0.5 shrink-0' />
                    <div className='min-w-0 flex-1'>
                      <div className='flex items-center justify-between gap-2'>
                        <span className='text-xs font-medium truncate'>
                          {displayOrigin(record.sharedWith)}
                        </span>
                        <span className='text-[9px] text-muted-foreground/50 shrink-0'>
                          {shortDate(record.sharedAt)}
                        </span>
                      </div>
                      <div className='font-mono text-[9px] text-muted-foreground/40 mt-0.5 truncate'>
                        {copied === `log-${i}` ? 'copied' : record.publicKey.slice(0, 32) + '...'}
                      </div>
                      <div className='text-[9px] text-muted-foreground/30 mt-0.5'>
                        identity: {record.identity}
                      </div>
                    </div>
                  </button>
                ))}
              </>
            )}
          </section>
        )}

        {/* ---- CONTACTS LINK ---- */}
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
          <div className='text-[10px] text-muted-foreground/30 text-center pb-2'>
            {keyInfo.name} - {keyInfo.type}
          </div>
        )}
      </div>
    </SettingsScreen>
  );
};

/** ---- QR canvas (inline, avoids importing heavy QrDisplay for simple hex) ---- */
const QrCanvas = ({ data, size }: { data: string; size: number }) => {
  const ref = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas || !data) return;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const QRCode = require('qrcode');
        QRCode.toCanvas(canvas, data, {
          width: size,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' },
          errorCorrectionLevel: 'L',
        });
      } catch {
        // silently fail - QR is optional UX
      }
    },
    [data, size],
  );

  return <canvas ref={ref} />;
};

/** ---- per-site card component ---- */
const SiteCard = ({
  site,
  siteLabels,
  editingLabel,
  labelInput,
  setEditingLabel,
  setLabelInput,
  saveLabel,
  expanded,
  onToggleExpand,
  confirming,
  onConfirm,
  onCancelConfirm,
  onUpdatePref,
  copied,
  onCopy,
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
  const [capsExpanded, setCapsExpanded] = useState(false);

  const ALL_CAPS: Capability[] = [
    'connect', 'sign_identity', 'send_tx', 'export_fvk',
    'view_contacts', 'view_history', 'frost', 'auto_sign',
  ];

  const handleCapToggle = async (cap: Capability, enabled: boolean) => {
    if (enabled) {
      await grantCapability(site.origin, cap);
    } else {
      await denyCapability(site.origin, cap);
    }
    onSitesChanged();
  };

  const handleRevoke = async () => {
    await revokeOriginPerms(site.origin);
    onSitesChanged();
  };

  return (
    <div className={`rounded-lg border overflow-hidden ${
      site.connected
        ? 'border-border/40 bg-card'
        : 'border-border/20 bg-card/50'
    }`}>
      {/* header row */}
      <button
        onClick={onToggleExpand}
        className='w-full flex items-center gap-2 p-3 text-left hover:bg-muted/30 transition-colors'
      >
        {/* connection indicator */}
        <span className={`h-2 w-2 rounded-full shrink-0 ${
          site.connected ? 'bg-green-400' : 'bg-muted-foreground/30'
        }`} />

        {/* site name / label */}
        <div className='flex-1 min-w-0'>
          {editingLabel === site.origin ? (
            <input
              autoFocus
              value={labelInput}
              onChange={e => setLabelInput(e.target.value)}
              onBlur={() => void saveLabel(site.origin, labelInput)}
              onClick={e => e.stopPropagation()}
              onKeyDown={e => {
                if (e.key === 'Enter') void saveLabel(site.origin, labelInput);
                if (e.key === 'Escape') setEditingLabel(null);
              }}
              className='text-xs bg-transparent border-b border-muted-foreground/30 outline-none w-full'
              placeholder='label this site...'
            />
          ) : (
            <div className='flex items-center gap-2'>
              <span className='text-xs font-medium truncate'>
                {siteLabels[site.origin] || displayOrigin(site.origin)}
              </span>
              {siteLabels[site.origin] && (
                <span className='text-[9px] text-muted-foreground/40 truncate'>
                  {displayOrigin(site.origin)}
                </span>
              )}
            </div>
          )}
        </div>

        {/* mode badge */}
        <span className={`shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] ${
          isSiteMode
            ? 'bg-green-500/10 text-green-400'
            : 'bg-yellow-500/10 text-yellow-400'
        }`}>
          <span className={`${isSiteMode ? 'i-lucide-shield' : 'i-lucide-link'} h-2.5 w-2.5`} />
          {isSiteMode ? 'site' : 'cross'}
        </span>

        {/* expand chevron */}
        <span className={`${expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'} h-3.5 w-3.5 text-muted-foreground/40 shrink-0`} />
      </button>

      {/* expanded details */}
      {expanded && (
        <div className='border-t border-border/40 p-3 flex flex-col gap-3'>
          {/* last shared pubkey */}
          {site.lastShared ? (
            <div>
              <div className='text-[9px] text-muted-foreground/50 mb-1'>last shared public key</div>
              <button
                onClick={() => onCopy(site.lastShared!.publicKey, site.origin)}
                className='flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground/70 hover:text-foreground transition-colors'
              >
                <span className={`${copied === site.origin ? 'i-lucide-check' : 'i-lucide-copy'} h-3 w-3 shrink-0`} />
                <span className='truncate'>
                  {copied === site.origin ? 'copied' : site.lastShared.publicKey}
                </span>
              </button>
              <div className='text-[9px] text-muted-foreground/40 mt-1'>
                last authenticated {shortDate(site.lastShared.sharedAt)}
                {' - '}shared {site.shares.length} time{site.shares.length !== 1 ? 's' : ''} total
              </div>
            </div>
          ) : (
            <div className='text-[10px] text-muted-foreground/40'>
              no key shared yet - will be recorded on first authentication
            </div>
          )}

          {/* identity mode controls */}
          <div className='flex flex-col gap-2'>
            <div className='text-[9px] text-muted-foreground/50'>identity mode</div>
            <div className='flex items-center gap-2'>
              {/* mode toggle */}
              <button
                onClick={() => {
                  if (isSiteMode) {
                    onConfirm('cross-site');
                  } else {
                    void onUpdatePref(site.origin, undefined);
                  }
                }}
                className='flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors'
              >
                <span className={`${isSiteMode ? 'i-lucide-shield' : 'i-lucide-link'} h-3.5 w-3.5`} />
                {isSiteMode ? 'site-specific (default)' : 'cross-site (linkable)'}
              </button>

              {/* rotation controls - only for site mode */}
              {isSiteMode && (
                <div className='ml-auto flex items-center gap-1'>
                  <span className='text-[9px] text-muted-foreground/40'>key #{rotation}</span>
                  <button
                    onClick={() => onConfirm('rotate')}
                    className='flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded hover:bg-muted/50'
                    title='rotate to a new key for this site'
                  >
                    <span className='i-lucide-refresh-cw h-3 w-3' />
                    <span>rotate</span>
                  </button>
                </div>
              )}
            </div>

            {/* label edit button */}
            <button
              onClick={() => {
                setEditingLabel(site.origin);
                setLabelInput(siteLabels[site.origin] ?? '');
              }}
              className='flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors'
            >
              <span className='i-lucide-tag h-3 w-3' />
              <span>{siteLabels[site.origin] ? 'edit label' : 'add label'}</span>
            </button>
          </div>

          {/* capabilities */}
          {site.perms && (
            <div className='flex flex-col gap-1'>
              <button
                onClick={() => setCapsExpanded(!capsExpanded)}
                className='flex items-center gap-1 text-[9px] text-muted-foreground/50 hover:text-muted-foreground transition-colors'
              >
                <span className={`${capsExpanded ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'} h-2.5 w-2.5`} />
                permissions ({site.perms.granted.length} granted)
              </button>
              {capsExpanded && (
                <div className='flex flex-col gap-0.5 pl-3 border-l border-border/20'>
                  {ALL_CAPS.map(cap => {
                    const meta = CAPABILITY_META[cap];
                    const granted = site.perms!.granted.includes(cap);
                    return (
                      <label key={cap} className='flex items-center justify-between gap-2 py-0.5'>
                        <span className={cn(
                          'text-[9px]',
                          meta.risk === 'low' && 'text-muted-foreground',
                          meta.risk === 'medium' && 'text-yellow-400',
                          meta.risk === 'high' && 'text-orange-400',
                          meta.risk === 'critical' && 'text-red-400',
                        )}>
                          {meta.label}
                        </span>
                        <input
                          type='checkbox'
                          checked={granted}
                          onChange={e => void handleCapToggle(cap, e.target.checked)}
                          className='h-3 w-3 accent-primary'
                        />
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* revoke */}
          <button
            onClick={() => void handleRevoke()}
            className='flex items-center gap-1.5 text-[10px] text-red-400/70 hover:text-red-400 transition-colors mt-1'
          >
            <span className='i-lucide-trash-2 h-3 w-3' />
            <span>revoke all permissions</span>
          </button>

          {/* confirmation: switch to cross-site */}
          {confirming === 'cross-site' && (
            <div className='rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3 flex flex-col gap-2'>
              <div className='flex items-start gap-2'>
                <span className='i-lucide-triangle-alert h-4 w-4 text-yellow-400 shrink-0 mt-0.5' />
                <div>
                  <p className='text-[10px] font-medium text-yellow-400'>enable cross-site identity?</p>
                  <p className='text-[9px] text-muted-foreground/70 mt-1 leading-relaxed'>
                    this site will receive the same public key you use on every other
                    cross-site origin. sites can collude to link your sessions and
                    build a profile of your activity.
                  </p>
                </div>
              </div>
              <div className='flex gap-2'>
                <button
                  onClick={onCancelConfirm}
                  className='flex-1 rounded border border-border/40 py-1.5 text-[10px] text-muted-foreground hover:bg-muted/50 transition-colors'
                >
                  keep site-specific
                </button>
                <button
                  onClick={() => void onUpdatePref(site.origin, {
                    mode: 'cross-site',
                    rotation: 0,
                    identity: site.pref.identity,
                  })}
                  className='flex-1 rounded border border-yellow-500/30 py-1.5 text-[10px] text-yellow-400 hover:bg-yellow-500/10 transition-colors'
                >
                  use cross-site
                </button>
              </div>
            </div>
          )}

          {/* confirmation: rotate key */}
          {confirming === 'rotate' && (
            <div className='rounded-lg border border-border/40 bg-muted/20 p-3 flex flex-col gap-2'>
              <div className='flex items-start gap-2'>
                <span className='i-lucide-refresh-cw h-4 w-4 text-muted-foreground shrink-0 mt-0.5' />
                <div>
                  <p className='text-[10px] font-medium text-foreground'>rotate to key #{rotation + 1}?</p>
                  <p className='text-[9px] text-muted-foreground/70 mt-1 leading-relaxed'>
                    this creates a new identity for this site.
                    the site keeps your old key on record - rotation only
                    affects future authentication signatures.
                  </p>
                </div>
              </div>
              <div className='flex gap-2'>
                <button
                  onClick={onCancelConfirm}
                  className='flex-1 rounded border border-border/40 py-1.5 text-[10px] text-muted-foreground hover:bg-muted/50 transition-colors'
                >
                  cancel
                </button>
                <button
                  onClick={() => void onUpdatePref(site.origin, {
                    mode: 'site',
                    rotation: rotation + 1,
                    identity: site.pref.identity,
                  })}
                  className='flex-1 rounded border border-primary/25 py-1.5 text-[10px] text-primary hover:bg-primary/10 transition-colors'
                >
                  rotate key
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
