/**
 * identity - your zid, connected sites, permissions, share log.
 *
 * the zid is a seed-derived ed25519 identity. each site gets a unique
 * key by default (unlinkable). cross-site mode is opt-in and dangerous.
 * rotation creates a fresh key for a site without affecting other sites.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo, selectKeyInfos } from '../../../state/keyring';
import { allContactsSelector } from '../../../state/contacts';
import { localExtStorage } from '@repo/storage-chrome/local';
import type { ZidSitePreference, ZidShareRecord } from '../../../state/identity';
import type { EncryptedVault } from '../../../state/keyring/types';
import { getOriginPermissions, grantCapability, denyCapability } from '@repo/storage-chrome/origin';
import { revokeOrigin as revokeOriginFull } from '../../../senders/revoke';
import { CAPABILITY_META, type Capability, type OriginPermissions } from '@repo/storage-chrome/capabilities';
import { isPro, selectDaysRemaining, selectPlan } from '../../../state/license';
import { SettingsScreen } from '../settings/settings-screen';
import { PopupPath } from '../paths';
import { QrScanner } from '../../../shared/components/qr-scanner';

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

/**
 * deterministic visual fingerprint from a hex pubkey.
 * renders a 5x5 grid of colored cells derived from the key bytes.
 * makes it easy to visually verify you are looking at the right identity.
 */
const ZidFingerprint = ({ pubkeyHex, size = 40 }: { pubkeyHex: string; size?: number }) => {
  const cells = useMemo(() => {
    const bytes: number[] = [];
    for (let i = 0; i < Math.min(pubkeyHex.length, 50); i += 2) {
      bytes.push(parseInt(pubkeyHex.slice(i, i + 2), 16));
    }
    // 5x5 grid = 25 cells, mirror horizontally for symmetry (like github identicons)
    const grid: string[] = [];
    const hue = ((bytes[0] ?? 0) * 360) / 256;
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 5; col++) {
        // mirror: col 0 = col 4, col 1 = col 3, col 2 = center
        const effCol = col < 3 ? col : 4 - col;
        const byteIdx = 1 + row * 3 + effCol;
        const val = bytes[byteIdx] ?? 0;
        const on = val > 127;
        const lightness = on ? 45 + (val % 20) : 15;
        const sat = on ? 60 + (val % 30) : 5;
        grid.push(`hsl(${hue}, ${sat}%, ${lightness}%)`);
      }
    }
    return grid;
  }, [pubkeyHex]);

  const cellSize = size / 5;
  return (
    <div
      className='rounded overflow-hidden shrink-0'
      style={{ width: size, height: size, display: 'grid', gridTemplateColumns: `repeat(5, ${cellSize}px)` }}
    >
      {cells.map((color, i) => (
        <div key={i} style={{ width: cellSize, height: cellSize, backgroundColor: color }} />
      ))}
    </div>
  );
};

export const IdentityPage = () => {
  const navigate = useNavigate();
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const allKeyInfos = useStore(selectKeyInfos);
  const contacts = useStore(allContactsSelector);
  const pro = useStore(isPro);
  const plan = useStore(selectPlan);
  const days = useStore(selectDaysRemaining);
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
  const [showFullKey, setShowFullKey] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const reloadSites = useCallback(() => setReloadKey(k => k + 1), []);

  // try active keyinfo first, then any keyinfo with a zid (mnemonic wallets)
  const zidPubkey = (keyInfo?.insensitive?.['zid'] ?? allKeyInfos.find(k => k.insensitive?.['zid'])?.insensitive?.['zid']) as string | undefined;
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

  const isZignerWallet = keyInfo?.type === 'zigner-zafu';
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [scanError, setScanError] = useState('');

  const handleZidScan = useCallback(async (raw: string) => {
    // accept "zid:<64hex>" or raw 64-char hex (from QR scanner's resultToHex)
    const prefixed = raw.match(/^zid:([0-9a-fA-F]{64})$/);
    const plain = raw.match(/^[0-9a-fA-F]{64}$/);
    const pubkey = prefixed?.[1] ?? plain?.[0];

    if (!pubkey) {
      setScanError('invalid ZID QR — expected "zid:<64hex>"');
      setScanStatus('error');
      setScanning(false);
      return;
    }

    try {
      // write pubkey to vault.insensitive['zid']
      const vaults = ((await localExtStorage.get('vaults')) ?? []) as EncryptedVault[];
      const updated = vaults.map(v =>
        v.id === keyInfo?.id ? { ...v, insensitive: { ...v.insensitive, zid: pubkey } } : v,
      );
      await localExtStorage.set('vaults', updated);

      // re-init keyring to pick up the change
      useStore.getState().keyRing.init();

      setScanStatus('success');
    } catch {
      setScanError('failed to save ZID');
      setScanStatus('error');
    }
    setScanning(false);
  }, [keyInfo?.id]);

  if (!zidPubkey) {
    const hasAnyWallet = allKeyInfos.length > 0;
    return (
      <SettingsScreen title='identity' backPath={PopupPath.INDEX}>
        <div className='flex flex-col gap-4'>
          {scanning ? (
            <QrScanner
              inline
              title='scan ZID from zigner'
              description='open key details on zigner, tap "show zid identity QR"'
              onScan={handleZidScan}
              onClose={() => setScanning(false)}
            />
          ) : (
            <div className='flex min-h-40 flex-col items-center justify-center'>
              <span className='i-lucide-fingerprint size-8 text-muted-foreground/30 mb-3' />
              {scanStatus === 'success' ? (
                <p className='text-sm text-green-400'>zid imported — reloading...</p>
              ) : isZignerWallet ? (
                <>
                  <p className='text-sm text-muted-foreground'>import zid from zigner</p>
                  <p className='mt-2 text-xs text-muted-foreground/50'>scan the zid QR from your zigner device.</p>
                  {scanStatus === 'error' && (
                    <p className='mt-2 text-xs text-red-400'>{scanError}</p>
                  )}
                  <button
                    onClick={() => { setScanStatus('idle'); setScanning(true); }}
                    className='mt-4 flex items-center gap-1.5 text-xs font-mono text-foreground border border-border/60 rounded px-3 py-1.5 hover:bg-muted/50'
                  >
                    <span className='i-lucide-scan-line size-3.5' />
                    scan zid QR
                  </button>
                </>
              ) : hasAnyWallet ? (
                <>
                  <p className='text-sm text-muted-foreground'>zid requires a mnemonic wallet</p>
                  <p className='mt-2 text-xs text-muted-foreground/50'>create a mnemonic wallet or import zid from zigner.</p>
                </>
              ) : (
                <>
                  <p className='text-sm text-muted-foreground'>no zid available</p>
                  <p className='mt-2 text-xs text-muted-foreground/50'>create a wallet to get started.</p>
                </>
              )}
            </div>
          )}

          <hr className='border-border/40' />

          <div className='flex flex-col gap-2'>
            <button
              onClick={() => navigate(PopupPath.CONTACTS)}
              className='flex items-center justify-between text-xs font-mono text-muted-foreground/50 hover:text-muted-foreground'
            >
              <span className='flex items-center gap-1.5'>
                <span className='i-lucide-users size-3.5' />
                contacts
              </span>
              <span className='text-muted-foreground/30'>{contactCount}</span>
            </button>
          </div>
        </div>
      </SettingsScreen>
    );
  }

  return (
    <SettingsScreen title='identity' backPath={PopupPath.INDEX}>
      <div className='flex flex-col gap-5'>

        {/* -- identity card -- */}
        <section className='rounded border border-border/40 p-3'>
          <div className='flex items-start gap-3'>
            <ZidFingerprint pubkeyHex={zidPubkey} size={44} />
            <div className='flex-1 min-w-0'>
              {/* address + copy */}
              <button
                onClick={() => copy(zidPubkey, 'zid')}
                className='flex items-center gap-1.5 group'
              >
                <span className='font-mono text-sm text-foreground'>{zidAddress}</span>
                <span className={`size-3.5 transition-colors ${
                  copied === 'zid'
                    ? 'i-lucide-check text-green-400'
                    : 'i-lucide-copy text-muted-foreground/40 group-hover:text-muted-foreground'
                }`} />
              </button>

              {/* vault name + plan badge */}
              <div className='flex items-center gap-2 mt-1'>
                {keyInfo && (
                  <span className='text-[10px] text-muted-foreground/50 font-mono'>{keyInfo.name}</span>
                )}
                <span className={`text-[9px] font-mono px-1.5 py-0 rounded ${
                  pro
                    ? 'bg-green-500/15 text-green-400 border border-green-500/20'
                    : 'bg-muted/50 text-muted-foreground/40 border border-border/40'
                }`}>
                  {plan}{pro && days > 0 ? ` - ${days}d` : ''}
                </span>
              </div>
            </div>
          </div>

          {/* full public key (expandable) */}
          <div className='mt-3'>
            <button
              onClick={() => setShowFullKey(!showFullKey)}
              className='flex items-center gap-1 text-[10px] text-muted-foreground/40 hover:text-muted-foreground font-mono'
            >
              <span className={`size-3 transition-transform ${showFullKey ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'}`} />
              public key
            </button>
            {showFullKey && (
              <button
                onClick={() => copy(zidPubkey, 'zid')}
                className='mt-1 pl-4 text-left'
              >
                <div className='font-mono text-[9px] text-muted-foreground/60 break-all leading-relaxed'>
                  {zidPubkey}
                </div>
              </button>
            )}
          </div>

          {/* qr toggle */}
          {showQr && (
            <div className='mt-3 flex justify-center'>
              <div className='bg-white p-2 rounded'><QrCanvas data={zidPubkey} size={140} /></div>
            </div>
          )}

          {/* action bar */}
          <div className='flex items-center gap-3 mt-3 pt-2 border-t border-border/20'>
            <button
              onClick={() => setShowQr(!showQr)}
              className='flex items-center gap-1 text-[10px] text-muted-foreground/40 hover:text-muted-foreground font-mono'
            >
              <span className={`size-3 ${showQr ? 'i-lucide-eye-off' : 'i-lucide-qr-code'}`} />
              {showQr ? 'hide qr' : 'qr code'}
            </button>
            <span className='text-border/40'>|</span>
            <span className='text-[10px] text-muted-foreground/30 font-mono'>{sites.length} sites</span>
            <span className='text-[10px] text-muted-foreground/30 font-mono'>{contactCount} contacts</span>
            {crossSiteCount > 0 && (
              <span className='text-[10px] text-yellow-500/60 font-mono'>{crossSiteCount} linkable</span>
            )}
          </div>
        </section>

        {/* -- derivation info -- */}
        <section className='rounded border border-border/20 p-3'>
          <div className='flex items-center gap-1.5 mb-2'>
            <span className='i-lucide-info size-3 text-muted-foreground/30' />
            <span className='text-[10px] font-mono text-muted-foreground/50'>how zid works</span>
          </div>
          <div className='text-[10px] font-mono text-muted-foreground/40 flex flex-col gap-1'>
            <p>each site gets a unique key derived from your seed.</p>
            <p>sites cannot link your identities across origins.</p>
            <p>rotating a key gives you a fresh identity for one site.</p>
          </div>
        </section>

        {/* -- tabs -- */}
        <div className='flex gap-4 text-xs font-mono'>
          <button
            onClick={() => setActiveTab('sites')}
            className={`flex items-center gap-1 ${activeTab === 'sites' ? 'text-foreground' : 'text-muted-foreground/40 hover:text-muted-foreground'}`}
          >
            <span className='i-lucide-globe size-3' />
            sites ({sites.length})
          </button>
          <button
            onClick={() => setActiveTab('log')}
            className={`flex items-center gap-1 ${activeTab === 'log' ? 'text-foreground' : 'text-muted-foreground/40 hover:text-muted-foreground'}`}
          >
            <span className='i-lucide-scroll-text size-3' />
            log ({shareLog.length})
          </button>
        </div>

        {/* -- sites -- */}
        {activeTab === 'sites' && (
          <section className='flex flex-col gap-1'>
            {sites.length === 0 ? (
              <div className='flex flex-col items-center py-6 text-muted-foreground/30'>
                <span className='i-lucide-globe size-6 mb-2' />
                <p className='text-xs font-mono'>no sites yet.</p>
                <p className='text-[10px] font-mono mt-1'>sites appear here after you authenticate.</p>
              </div>
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

        {/* -- log -- */}
        {activeTab === 'log' && (
          <section className='flex flex-col gap-0'>
            {shareLog.length === 0 ? (
              <div className='flex flex-col items-center py-6 text-muted-foreground/30'>
                <span className='i-lucide-scroll-text size-6 mb-2' />
                <p className='text-xs font-mono'>no keys shared yet.</p>
              </div>
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

        {/* -- links -- */}
        <div className='flex flex-col gap-2'>
          <button
            onClick={() => navigate(PopupPath.CONTACTS)}
            className='flex items-center justify-between text-xs font-mono text-muted-foreground/50 hover:text-muted-foreground'
          >
            <span className='flex items-center gap-1.5'>
              <span className='i-lucide-users size-3.5' />
              contacts
            </span>
            <span className='text-muted-foreground/30'>{contactCount}</span>
          </button>
          <button
            onClick={() => navigate(PopupPath.PASSWORDS)}
            className='flex items-center justify-between text-xs font-mono text-muted-foreground/50 hover:text-muted-foreground'
          >
            <span className='flex items-center gap-1.5'>
              <span className='i-lucide-key-round size-3.5' />
              passwords
            </span>
            <span className='i-lucide-chevron-right size-3 text-muted-foreground/30' />
          </button>
          {!pro && (
            <button
              onClick={() => navigate(PopupPath.SUBSCRIBE)}
              className='flex items-center justify-between text-xs font-mono text-muted-foreground/50 hover:text-muted-foreground'
            >
              <span className='flex items-center gap-1.5'>
                <span className='i-lucide-sparkles size-3.5' />
                upgrade to pro
              </span>
              <span className='i-lucide-chevron-right size-3 text-muted-foreground/30' />
            </button>
          )}
        </div>
      </div>
    </SettingsScreen>
  );
};

/* -- qr -- */
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

/* -- site row -- */
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
    revokeOriginFull(site.origin);
    onSitesChanged();
  };

  return (
    <div className={`border-b border-border/30 last:border-0 ${!site.connected ? 'opacity-40' : ''}`}>
      {/* header */}
      <button onClick={onToggleExpand} className='w-full flex items-center justify-between py-2 text-left'>
        <div className='flex items-center gap-2 min-w-0'>
          <span className={`size-3 shrink-0 ${
            site.connected ? 'i-lucide-link text-green-400/60' : 'i-lucide-unlink text-muted-foreground/30'
          }`} />
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
          {!isSiteMode && (
            <span className='text-[8px] text-yellow-400/60 font-mono px-1 border border-yellow-500/20 rounded'>cross</span>
          )}
        </div>
        <div className='flex items-center gap-2 shrink-0'>
          <span className='text-[9px] text-muted-foreground/40 font-mono'>
            {site.perms ? `${site.perms.granted.length} caps` : ''}
            {isSiteMode && rotation > 0 ? ` #${rotation}` : ''}
          </span>
          <span className={`size-3 transition-transform ${expanded ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'} text-muted-foreground/30`} />
        </div>
      </button>

      {/* expanded */}
      {expanded && (
        <div className='pb-3 pl-7 flex flex-col gap-2.5 text-[10px] font-mono'>
          {/* last shared key */}
          {site.lastShared && (
            <button onClick={() => onCopy(site.lastShared!.publicKey, site.origin)} className='flex items-center gap-1 text-left text-muted-foreground/40 hover:text-muted-foreground'>
              <span className={`size-3 ${copied === site.origin ? 'i-lucide-check text-green-400' : 'i-lucide-copy'}`} />
              <span className='truncate'>{site.lastShared.publicKey.slice(0, 36)}...</span>
            </button>
          )}

          {/* identity mode toggle */}
          <div className='flex flex-col gap-1.5'>
            <span className='text-muted-foreground/40'>identity mode</span>
            <div className='flex items-center gap-0'>
              <button
                onClick={() => !isSiteMode ? void onUpdatePref(site.origin, undefined) : undefined}
                className={`flex items-center gap-1 px-2 py-0.5 rounded-l border text-[10px] transition-colors ${
                  isSiteMode
                    ? 'bg-green-500/15 border-green-500/30 text-green-400'
                    : 'border-border/40 text-muted-foreground/40 hover:text-muted-foreground'
                }`}
              >
                <span className='i-lucide-shield-check size-3' />
                unique
              </button>
              <button
                onClick={() => isSiteMode ? onConfirm('cross-site') : undefined}
                className={`flex items-center gap-1 px-2 py-0.5 rounded-r border border-l-0 text-[10px] transition-colors ${
                  !isSiteMode
                    ? 'bg-yellow-500/15 border-yellow-500/30 text-yellow-400'
                    : 'border-border/40 text-muted-foreground/40 hover:text-muted-foreground'
                }`}
              >
                <span className='i-lucide-link size-3' />
                shared
              </button>
            </div>
            {!isSiteMode && (
              <span className='text-yellow-500/50'>
                <span className='i-lucide-triangle-alert size-3 inline-block align-text-bottom mr-0.5' />
                sites with shared key can link your sessions
              </span>
            )}
          </div>

          {/* rotation control */}
          {isSiteMode && (
            <div className='flex flex-col gap-1'>
              <span className='text-muted-foreground/40'>key rotation</span>
              <div className='flex items-center gap-1.5'>
                <button
                  onClick={() => rotation > 0 ? void onUpdatePref(site.origin, { ...site.pref, rotation: rotation - 1 }) : undefined}
                  disabled={rotation === 0}
                  className='hover:text-muted-foreground disabled:opacity-20 text-muted-foreground/50'
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
                  className='hover:text-muted-foreground text-muted-foreground/50'
                >
                  <span className='i-lucide-plus size-3' />
                </button>
                {rotation === 0 && (
                  <span className='text-muted-foreground/30 ml-1'>original key</span>
                )}
                {rotation > 0 && (
                  <span className='text-muted-foreground/40 ml-1'>rotated {rotation}x</span>
                )}
              </div>
            </div>
          )}

          {/* quick actions */}
          <div className='flex items-center gap-3 text-muted-foreground/50 pt-1'>
            <button
              onClick={() => { setEditingLabel(site.origin); setLabelInput(siteLabels[site.origin] ?? ''); }}
              className='flex items-center gap-1 hover:text-muted-foreground'
            >
              <span className='i-lucide-tag size-3' />
              label
            </button>
            {site.perms && (
              <button onClick={() => setCapsOpen(!capsOpen)} className='flex items-center gap-1 hover:text-muted-foreground'>
                <span className='i-lucide-shield size-3' />
                {capsOpen ? 'hide' : 'permissions'}
              </button>
            )}
            <button onClick={() => void handleRevoke()} className='flex items-center gap-1 hover:text-red-400/80'>
              <span className='i-lucide-x size-3' />
              revoke
            </button>
          </div>

          {/* capabilities */}
          {capsOpen && site.perms && (
            <div className='flex flex-col gap-0.5 pl-2 border-l border-border/20'>
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

          {/* confirmations */}
          {confirming === 'cross-site' && (
            <div className='pl-2 border-l-2 border-yellow-500/30'>
              <p className='text-yellow-500/50 mb-1.5'>same key across all origins. sites can link your sessions.</p>
              <div className='flex gap-2'>
                <button onClick={onCancelConfirm} className='text-muted-foreground/40 hover:text-muted-foreground'>cancel</button>
                <button
                  onClick={() => void onUpdatePref(site.origin, { mode: 'cross-site', rotation: 0, identity: site.pref.identity })}
                  className='text-yellow-400/80 hover:text-yellow-400'
                >confirm</button>
              </div>
            </div>
          )}
          {confirming === 'rotate' && (
            <div className='pl-2 border-l-2 border-border/40'>
              <p className='text-muted-foreground/50 mb-1.5'>
                new key #{rotation + 1}. old key #{rotation} is abandoned - site keeps whatever key it had.
              </p>
              <div className='flex gap-2'>
                <button onClick={onCancelConfirm} className='text-muted-foreground/40 hover:text-muted-foreground'>cancel</button>
                <button
                  onClick={() => void onUpdatePref(site.origin, { mode: 'site', rotation: rotation + 1, identity: site.pref.identity })}
                  className='text-foreground hover:text-foreground'
                >rotate</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
