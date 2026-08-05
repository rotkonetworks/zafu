/**
 * identity - your zid, connected sites, permissions, share log.
 *
 * the zid is a seed-derived ed25519 identity. each site gets a unique
 * key by default (unlinkable). cross-site mode is opt-in and dangerous.
 * rotation creates a fresh key for a site without affecting other sites.
 *
 * visual model: "identity as an object". the current generation is a
 * physical keycard sitting on a visible stack of its sibling generations.
 * the gen index is the hero number; pins are index-tabs on the stack.
 * default view stays terse - full pubkey, qr, and per-site controls all
 * live behind hover/expand reveals (see DESIGN.md restraint).
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo, selectKeyInfos, selectGetMnemonic } from '../../../state/keyring';
import { allContactsSelector } from '../../../state/contacts';
import { localExtStorage } from '@repo/storage-chrome/local';
import type { ZidSitePreference, ZidShareRecord } from '../../../state/identity';
import {
  ZID_INDEX_STORAGE_KEY,
  ZID_PINS_STORAGE_KEY,
  type ZidPin,
  addZidPin,
  getZidIndex,
  getZidPins,
  removeZidPin,
  rotateZidIndex,
  rotateZidIndexDown,
  setZidIndex,
  getZidGenKeys,
  ZID_GEN_KEYS_STORAGE_KEY,
  deriveAndCacheZidGeneration,
} from '../../../state/identity';
import { getOriginPermissions, grantCapability, denyCapability } from '@repo/storage-chrome/origin';
import { revokeOrigin as revokeOriginFull } from '../../../senders/revoke';
import {
  CAPABILITY_META,
  type Capability,
  type OriginPermissions,
} from '@repo/storage-chrome/capabilities';
import { isPro, selectDaysRemaining, selectPlan } from '../../../state/license';
import { SettingsScreen } from '../settings/settings-screen';
import { PopupPath } from '../paths';
import { PASSWORD_GENERATOR } from '../../../config/feature-flags';

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

/** shared focus-visible ring for every interactive control (keyboard access). */
const focusRing =
  'focus:outline-none focus-visible:ring-1 focus-visible:ring-network-accent focus-visible:ring-offset-0';

/* keycard depth - decorative shadows/tints with no token equivalent, kept
   inline the same way glass-surface composes its rim. gold = zigner-gold
   (#f4b728), the only accent the live identity is allowed to carry. */
const CARD_STYLE: CSSProperties = {
  background:
    'radial-gradient(120% 90% at 12% 0%, rgba(244,183,40,0.10) 0%, rgba(244,183,40,0) 42%), linear-gradient(158deg, #151515 0%, #0c0c0c 46%, #070707 100%)',
  borderTopColor: 'rgba(244,183,40,0.30)',
  boxShadow:
    'inset 0 1px 0 rgba(255,255,255,0.05), inset 0 -1px 0 rgba(0,0,0,0.55), 0 0 0 1px rgba(244,183,40,0.06), 0 2px 4px rgba(0,0,0,0.5), 0 18px 34px -16px rgba(0,0,0,0.95)',
};
const GHOST_STYLE: CSSProperties = { background: 'linear-gradient(180deg, #0c0c0c, #070707)' };
const CHIP_STYLE: CSSProperties = {
  boxShadow:
    'inset 0 0 0 1px rgba(255,255,255,0.06), 0 0 0 3px rgba(0,0,0,0.6), 0 0 0 4px rgba(244,183,40,0.16), 0 4px 10px -4px rgba(0,0,0,0.9)',
};
const CHIP_GLOSS: CSSProperties = {
  background: 'linear-gradient(150deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0) 40%)',
};
const WATERMARK_STYLE: CSSProperties = {
  fontSize: 96,
  color: 'rgba(244,183,40,0.05)',
  letterSpacing: '-0.04em',
};
const HERO_STYLE: CSSProperties = { textShadow: '0 0 18px rgba(244,183,40,0.28)' };

const shortDate = (ms: number): string => {
  const d = new Date(ms);
  const diff = Date.now() - ms;
  if (diff < 86400000) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  if (diff < 604800000) {
    return d.toLocaleDateString(undefined, { weekday: 'short' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const displayOrigin = (origin: string): string =>
  origin.replace(/^https?:\/\//, '').replace(/\/$/, '');

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** honor the OS "reduce motion" setting for the card-stack morph. */
const usePrefersReducedMotion = (): boolean => {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
};

/**
 * deterministic visual fingerprint from a hex pubkey — a personal hanko.
 *
 * A zid IS a signing identity, and the traditional mark of a signing
 * identity is a seal: a vermillion square carrying one character, pressed
 * slightly askew. Both the character and the tilt are derived from the
 * key bytes, so every generation gets its own recognizable stamp.
 */
const SEAL_KANJI = [
  ...'松竹梅月山川雪花風林火水石空海島雲星霜露谷岩波泉森光影音刀弓馬鶴亀龍虎蓮桜柳楓菊苔庭道門橋鈴壺筆墨',
];

const ZidFingerprint = ({ pubkeyHex, size = 40 }: { pubkeyHex: string; size?: number }) => {
  const { glyph, tilt } = useMemo(() => {
    const b0 = parseInt(pubkeyHex.slice(0, 2), 16) || 0;
    const b1 = parseInt(pubkeyHex.slice(2, 4), 16) || 0;
    const b2 = parseInt(pubkeyHex.slice(4, 6), 16) || 0;
    // two bytes select the glyph so the space is used evenly
    const idx = (b0 * 256 + b1) % SEAL_KANJI.length;
    return { glyph: SEAL_KANJI[idx]!, tilt: (b2 % 13) - 6 };
  }, [pubkeyHex]);

  return (
    <div
      className='relative flex shrink-0 select-none items-center justify-center border-hanko text-hanko'
      style={{
        width: size,
        height: size,
        borderWidth: Math.max(1.5, size / 30),
        borderRadius: size / 7,
        fontSize: size * 0.48,
        transform: `rotate(${tilt}deg)`,
      }}
      title='your seal — changes with each generation'
    >
      <span
        aria-hidden
        className='absolute border border-hanko/35'
        style={{ inset: size / 14, borderRadius: size / 12 }}
      />
      {glyph}
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
  const [confirming, setConfirming] = useState<{
    origin: string;
    action: 'cross-site' | 'rotate';
  } | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [showFullKey, setShowFullKey] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [zidIndex, setZidIndexState] = useState(0);
  const [zidPins, setZidPins] = useState<ZidPin[]>([]);
  // inline pin rename: which pin index is being edited + the draft label
  const [editingPin, setEditingPin] = useState<number | null>(null);
  const [pinDraft, setPinDraft] = useState('');
  const reloadSites = useCallback(() => setReloadKey(k => k + 1), []);

  // card-stack morph: a subtle settle when the generation changes. gated by
  // prefers-reduced-motion so it never animates for users who opt out.
  const reducedMotion = usePrefersReducedMotion();
  const [morph, setMorph] = useState(false);
  const firstGenRef = useRef(true);
  useEffect(() => {
    if (firstGenRef.current) {
      firstGenRef.current = false;
      return;
    }
    if (reducedMotion) {
      return;
    }
    setMorph(true);
    const t = window.setTimeout(() => setMorph(false), 340);
    return () => window.clearTimeout(t);
  }, [zidIndex, reducedMotion]);

  // load + subscribe to global zidIndex + pinned generations (chrome.storage.local)
  useEffect(() => {
    void getZidIndex().then(setZidIndexState);
    void getZidPins().then(setZidPins);
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') {
        return;
      }
      if (changes[ZID_INDEX_STORAGE_KEY]) {
        const v = changes[ZID_INDEX_STORAGE_KEY].newValue;
        if (typeof v === 'number') {
          setZidIndexState(v);
        }
      }
      if (changes[ZID_PINS_STORAGE_KEY]) {
        void getZidPins().then(setZidPins);
      }
      if (changes[ZID_GEN_KEYS_STORAGE_KEY]) {
        void getZidGenKeys().then(setGenKeys);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  // Rotation is reversible: up = next generation, down = previous. Every
  // generation is a deterministic derivation, so switching never destroys an
  // identity - you can always rotate back down (or jump to a pin) to restore it.
  const handleRotateUp = useCallback(async () => {
    await rotateZidIndex();
    reloadSites();
  }, [reloadSites]);

  const handleRotateDown = useCallback(async () => {
    await rotateZidIndexDown();
    reloadSites();
  }, [reloadSites]);

  const handleJumpTo = useCallback(
    async (index: number) => {
      await setZidIndex(index);
      reloadSites();
    },
    [reloadSites],
  );

  const handlePinCurrent = useCallback(async () => {
    setZidPins(await addZidPin(zidIndex, `gen ${zidIndex}`));
  }, [zidIndex]);

  const handleUnpin = useCallback(async (index: number) => {
    setZidPins(await removeZidPin(index));
  }, []);

  // rename a pinned generation locally (label only - keys are untouched).
  // addZidPin replaces the existing pin at that index.
  const handleRenamePin = useCallback(
    async (index: number, label: string) => {
      const existing = zidPins.find(p => p.index === index);
      const next = label.trim();
      if (next && next !== existing?.label) {
        setZidPins(await addZidPin(index, next));
      }
      setEditingPin(null);
    },
    [zidPins],
  );

  // try active keyinfo first, then any keyinfo with a zid (mnemonic wallets)
  const storedZid = (keyInfo?.insensitive?.['zid'] ??
    allKeyInfos.find(k => k.insensitive?.['zid'])?.insensitive?.['zid']) as string | undefined;
  // generation-aware: the stored value is generation 0 (written at vault
  // creation); rotated generations come from the derived-key cache, filled
  // on rotation below. Without this, rotating generations changed nothing
  // on screen — the icon and zid stayed pinned to gen 0.
  const getMnemonic = useStore(selectGetMnemonic);
  const [genKeys, setGenKeys] = useState<Record<number, string>>({});
  useEffect(() => {
    void getZidGenKeys().then(setGenKeys);
  }, []);
  const zidPubkey = genKeys[zidIndex] ?? (zidIndex === 0 ? storedZid : undefined);
  const zidAddress = zidPubkey ? 'zid' + zidPubkey.slice(0, 16) : undefined;

  // derive + cache the active generation's key whenever it's missing (the
  // wallet is unlocked here, so getMnemonic works without a prompt)
  const mnemonicVault = allKeyInfos.find(k => k.insensitive?.['zid']);
  useEffect(() => {
    if (zidPubkey || !mnemonicVault) {
      return;
    }
    void (async () => {
      try {
        const mnemonic = await getMnemonic(mnemonicVault.id);
        await deriveAndCacheZidGeneration(mnemonic, zidIndex);
        setGenKeys(await getZidGenKeys());
      } catch {
        /* locked or non-mnemonic vault — stored gen-0 display only */
      }
    })();
  }, [zidIndex, zidPubkey, mnemonicVault, getMnemonic]);

  useEffect(() => {
    void (async () => {
      const [prefs, log, labels, knownSitesRaw] = await Promise.all([
        localExtStorage.get('zidPreferences') as Promise<
          Record<string, ZidSitePreference> | undefined
        >,
        localExtStorage.get('zidShareLog') as Promise<ZidShareRecord[] | undefined>,
        localExtStorage.get('zidSiteLabels'),
        localExtStorage.get('knownSites') as Promise<
          { origin: string; choice: string }[] | undefined
        >,
      ]);

      setSiteLabels(labels ?? {});
      setShareLog(log ?? []);

      const approvedOrigins = new Set<string>();
      if (Array.isArray(knownSitesRaw)) {
        for (const s of knownSitesRaw) {
          if (s.choice === 'Approved') {
            approvedOrigins.add(s.origin);
          }
        }
      }

      const allOrigins = new Set<string>();
      if (prefs) {
        Object.keys(prefs).forEach(o => allOrigins.add(o));
      }
      if (log) {
        log.forEach(r => allOrigins.add(r.sharedWith));
      }

      const siteList: SiteIdentity[] = [];
      for (const origin of allOrigins) {
        const pref = prefs?.[origin] ?? { mode: 'site' as const, rotation: 0, identity: 'default' };
        const shares = log?.filter(r => r.sharedWith === origin) ?? [];
        const lastShared = shares[shares.length - 1];
        const connected = approvedOrigins.has(origin);
        const perms = await getOriginPermissions(origin);
        siteList.push({
          origin,
          pref,
          shares,
          lastShared,
          label: labels?.[origin],
          connected,
          perms,
        });
      }

      siteList.sort((a, b) => {
        if (a.connected !== b.connected) {
          return a.connected ? -1 : 1;
        }
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
    const labels = (await localExtStorage.get('zidSiteLabels'))! ?? {};
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
    const prefs =
      ((await localExtStorage.get('zidPreferences')) as Record<string, ZidSitePreference>) ?? {};
    if (next) {
      prefs[origin] = next;
    } else {
      delete prefs[origin];
    }
    await localExtStorage.set('zidPreferences', prefs);
    setSites(prev =>
      prev.map(s =>
        s.origin === origin
          ? { ...s, pref: next ?? { mode: 'site', rotation: 0, identity: 'default' } }
          : s,
      ),
    );
    setConfirming(null);
  }, []);

  const crossSiteCount = useMemo(
    () => sites.filter(s => s.pref.mode === 'cross-site').length,
    [sites],
  );
  const contactCount = contacts?.length ?? 0;

  if (!zidPubkey) {
    const hasAnyWallet = allKeyInfos.length > 0;
    const hasAnyZignerWallet = allKeyInfos.some(k => k.type === 'zigner-zafu');
    return (
      <SettingsScreen title='identity' backPath={PopupPath.INDEX}>
        <div className='flex flex-col gap-4'>
          <div className='flex min-h-40 flex-col items-center justify-center'>
            <span className='i-lucide-fingerprint size-8 text-fg-muted mb-3' />
            {hasAnyWallet ? (
              <>
                <p className='text-sm text-fg-muted'>zid not available</p>
                <p className='mt-2 text-xs text-fg-muted text-center px-6'>
                  create a mnemonic wallet
                  {hasAnyZignerWallet
                    ? ', or re-import your zigner wallet with the latest zigner build - the fvk QR now embeds your zid automatically.'
                    : ' to get a zid. zigner-imported wallets also provision a zid when imported from a current zigner build.'}
                </p>
              </>
            ) : (
              <>
                <p className='text-sm text-fg-muted'>no zid available</p>
                <p className='mt-2 text-xs text-fg-muted'>create a wallet to get started.</p>
              </>
            )}
          </div>

          <hr className='border-border-soft' />

          <div className='flex flex-col gap-2'>
            <button
              onClick={() => navigate(PopupPath.CONTACTS)}
              className={`flex items-center justify-between text-xs font-mono text-fg-muted hover:text-fg-high transition-colors ${focusRing}`}
            >
              <span className='flex items-center gap-1.5'>
                <span className='i-lucide-users size-3.5' />
                contacts
              </span>
              <span className='text-fg-muted'>{contactCount}</span>
            </button>
          </div>
        </div>
      </SettingsScreen>
    );
  }

  const genPad = pad2(zidIndex);
  const isPinned = zidPins.some(p => p.index === zidIndex);
  // ghost cards = the generations beneath the current one (honest depth: none
  // at gen 0, one below at gen 1, two-or-more below from gen 2 up).
  const stackDepth = Math.min(zidIndex, 2);

  return (
    <SettingsScreen title='identity' backPath={PopupPath.INDEX}>
      <div className='flex flex-col gap-5'>
        {/* -- identity object: the keycard on its stack -- */}
        <div className='flex flex-col gap-3'>
          <section className='relative pt-3'>
            {/* ghost cards behind = sibling generations in the stack */}
            {stackDepth >= 2 && (
              <div
                aria-hidden
                className='absolute left-4 right-4 top-0 h-14 z-0 border border-border-soft opacity-30'
                style={GHOST_STYLE}
              />
            )}
            {stackDepth >= 1 && (
              <div
                aria-hidden
                className='absolute left-2 right-2 top-1.5 h-14 z-[1] border border-border-soft opacity-60'
                style={GHOST_STYLE}
              />
            )}

            <div
              className={`relative z-[2] overflow-hidden border border-border-hard p-3.5 will-change-transform ease-out motion-safe:transition-transform motion-safe:duration-300 ${
                morph ? 'translate-y-[3px] scale-[0.99]' : 'translate-y-0 scale-100'
              }`}
              style={CARD_STYLE}
            >
              {/* engraved generation watermark */}
              <span
                aria-hidden
                className='pointer-events-none absolute -top-3 right-1 select-none font-headline font-bold leading-none tabular'
                style={WATERMARK_STYLE}
              >
                {genPad}
              </span>

              {/* card head: object label + plan chip */}
              <div className='relative z-[1] flex items-center justify-between mb-3'>
                <span className='kicker flex items-center gap-1.5'>
                  <span className='i-lucide-fingerprint size-3.5 text-network-accent' />
                  zafu id
                </span>
                <span
                  className={`flex items-center gap-1 text-label font-mono px-1.5 py-0.5 border ${
                    pro
                      ? 'border-network-accent/35 bg-network-accent/10 text-network-accent-light'
                      : 'border-border-soft bg-elev-2 text-fg-muted'
                  }`}
                  title={pro ? 'zafu pro' : 'free plan'}
                >
                  {pro && <span className='i-lucide-crown size-3' />}
                  {plan}
                  {pro && days > 0 ? ` · ${days}d` : ''}
                </span>
              </div>

              {/* card body: fingerprint chip + short zid */}
              <div className='relative z-[1] flex items-center gap-3'>
                <div className='relative shrink-0 overflow-hidden' style={CHIP_STYLE}>
                  <ZidFingerprint pubkeyHex={zidPubkey} size={48} />
                  <span
                    aria-hidden
                    className='pointer-events-none absolute inset-0'
                    style={CHIP_GLOSS}
                  />
                </div>
                <div className='min-w-0 flex-1'>
                  <button
                    onClick={() => copy(zidPubkey, 'zid')}
                    title='copy public key'
                    className={`flex items-center gap-1.5 group max-w-full ${focusRing}`}
                  >
                    <span className='font-mono text-data text-fg-high truncate'>
                      <span className='text-network-accent'>{zidAddress?.slice(0, 3)}</span>
                      {zidAddress?.slice(3)}
                    </span>
                    <span
                      className={`size-3.5 shrink-0 transition-colors ${
                        copied === 'zid'
                          ? 'i-lucide-check text-success'
                          : 'i-lucide-copy text-fg-dim group-hover:text-fg-muted'
                      }`}
                    />
                  </button>
                  {keyInfo?.name && (
                    <div className='mt-1 flex items-center gap-1.5 text-label font-mono text-fg-muted'>
                      <span className='i-lucide-layers size-3 text-fg-dim' />
                      <span className='truncate'>{keyInfo.name}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* reversible generation switcher - rotate down/up to morph
                  between generations, pin to bookmark. hints live in title
                  tooltips so the default view stays terse. */}
              <div className='relative z-[1] mt-3.5 flex items-center gap-2.5 border border-border-soft bg-black/40 p-3'>
                <button
                  type='button'
                  onClick={() => void handleRotateDown()}
                  disabled={zidIndex === 0}
                  title='previous generation (rotate down)'
                  className={`grid size-8 shrink-0 place-items-center border border-border-hard bg-elev-1 text-fg-muted transition-colors hover:text-fg-high hover:border-fg-dim disabled:opacity-30 disabled:hover:text-fg-muted disabled:hover:border-border-hard ${focusRing}`}
                >
                  <span className='i-lucide-chevron-left size-4' />
                </button>
                <div className='flex-1 text-center leading-none'>
                  <div className='text-label text-fg-muted lowercase tracking-wide'>generation</div>
                  <div
                    className='text-display tabular text-network-accent-light'
                    style={HERO_STYLE}
                  >
                    {genPad}
                  </div>
                </div>
                <button
                  type='button'
                  onClick={() => void handleRotateUp()}
                  title='next generation (rotate up)'
                  className={`grid size-8 shrink-0 place-items-center border border-border-hard bg-elev-1 text-fg-muted transition-colors hover:text-fg-high hover:border-fg-dim ${focusRing}`}
                >
                  <span className='i-lucide-chevron-right size-4' />
                </button>
                <button
                  type='button'
                  onClick={() => (isPinned ? void handleUnpin(zidIndex) : void handlePinCurrent())}
                  title={isPinned ? 'unpin this generation' : 'pin this generation'}
                  className={`grid size-8 shrink-0 place-items-center border transition-colors ${focusRing} ${
                    isPinned
                      ? 'border-network-accent/35 bg-network-accent/10 text-network-accent'
                      : 'border-border-hard text-fg-muted hover:text-fg-high hover:border-fg-dim'
                  }`}
                >
                  <span className={`size-4 ${isPinned ? 'i-lucide-pin-off' : 'i-lucide-pin'}`} />
                </button>
              </div>

              {/* pins = saved generations / index tabs. hidden until pinned. */}
              {zidPins.length > 0 && (
                <div className='relative z-[1] mt-3 flex flex-wrap items-center gap-1.5'>
                  <span className='text-label text-fg-dim lowercase mr-0.5'>pinned</span>
                  {zidPins.map(p =>
                    editingPin === p.index ? (
                      <span
                        key={p.index}
                        className='flex items-center gap-1 text-label font-mono px-2 py-0.5 border border-network-accent/40 bg-network-accent/10'
                      >
                        <span className='i-lucide-pin size-3 text-network-accent' />
                        <input
                          autoFocus
                          value={pinDraft}
                          onChange={e => setPinDraft(e.target.value)}
                          onBlur={() => void handleRenamePin(p.index, pinDraft)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') {
                              void handleRenamePin(p.index, pinDraft);
                            }
                            if (e.key === 'Escape') {
                              setEditingPin(null);
                            }
                          }}
                          maxLength={24}
                          placeholder={`gen ${p.index}`}
                          className={`w-16 bg-transparent text-label font-mono text-fg-high outline-none ${focusRing}`}
                        />
                      </span>
                    ) : (
                      <span
                        key={p.index}
                        className={`flex items-center border transition-colors ${
                          p.index === zidIndex
                            ? 'border-network-accent/40 bg-network-accent/10 text-network-accent'
                            : 'border-border-hard text-fg-muted'
                        }`}
                      >
                        <button
                          type='button'
                          onClick={() => void handleJumpTo(p.index)}
                          title={`switch to ${p.label} (gen ${p.index})`}
                          className={`flex items-center gap-1 text-label font-mono pl-2 pr-1 py-0.5 transition-colors hover:text-fg-high ${focusRing}`}
                        >
                          <span className='i-lucide-pin size-3' />
                          {p.label}
                        </button>
                        <button
                          type='button'
                          onClick={() => {
                            setEditingPin(p.index);
                            setPinDraft(p.label);
                          }}
                          title='rename pin'
                          className={`grid place-items-center px-1 py-0.5 text-fg-dim transition-colors hover:text-fg-high ${focusRing}`}
                        >
                          <span className='i-lucide-pencil size-2.5' />
                        </button>
                      </span>
                    ),
                  )}
                </div>
              )}
            </div>

            {morph && (
              <span className='sr-only' aria-live='polite'>{`generation ${zidIndex}`}</span>
            )}
          </section>

          {/* quiet controls beneath the card: reveals for the full pubkey + qr,
              plus the cross-site linkable signal. detail on demand only. */}
          <div className='flex flex-col gap-2'>
            <div className='flex items-center gap-4 text-label font-mono'>
              <button
                onClick={() => setShowFullKey(!showFullKey)}
                title='show full public key'
                className={`flex items-center gap-1 text-fg-muted hover:text-fg-high transition-colors ${focusRing}`}
              >
                <span
                  className={`size-3 transition-transform ${showFullKey ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'}`}
                />
                public key
              </button>
              <button
                onClick={() => setShowQr(!showQr)}
                title='show qr code'
                className={`flex items-center gap-1 text-fg-muted hover:text-fg-high transition-colors ${focusRing}`}
              >
                <span className={`size-3 ${showQr ? 'i-lucide-eye-off' : 'i-lucide-qr-code'}`} />
                {showQr ? 'hide qr' : 'qr code'}
              </button>
              {crossSiteCount > 0 && (
                <span
                  className='flex items-center gap-1 text-warning'
                  title='sites sharing a key can link your sessions'
                >
                  <span className='i-lucide-triangle-alert size-3' />
                  {crossSiteCount} linkable
                </span>
              )}
            </div>

            {showFullKey && (
              <button
                onClick={() => copy(zidPubkey, 'zid')}
                title='copy public key'
                className={`text-left border border-border-soft bg-elev-1 p-2 ${focusRing}`}
              >
                <span className='block font-mono text-label text-fg-muted break-all leading-relaxed hover:text-fg'>
                  {zidPubkey}
                </span>
              </button>
            )}

            {showQr && (
              <div className='flex justify-center'>
                <div className='bg-white p-2'>
                  <QrCanvas data={zidPubkey} size={140} />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* -- tabs -- */}
        <div className='flex gap-4 border-b border-border-soft text-body font-mono'>
          <button
            onClick={() => setActiveTab('sites')}
            className={`-mb-px flex items-center gap-1.5 pb-2 border-b-2 transition-colors ${focusRing} ${
              activeTab === 'sites'
                ? 'border-network-accent text-fg-high'
                : 'border-transparent text-fg-muted hover:text-fg'
            }`}
          >
            <span className='i-lucide-globe size-3.5' />
            sites <span className='text-fg-dim'>({sites.length})</span>
          </button>
          <button
            onClick={() => setActiveTab('log')}
            className={`-mb-px flex items-center gap-1.5 pb-2 border-b-2 transition-colors ${focusRing} ${
              activeTab === 'log'
                ? 'border-network-accent text-fg-high'
                : 'border-transparent text-fg-muted hover:text-fg'
            }`}
          >
            <span className='i-lucide-scroll-text size-3.5' />
            log <span className='text-fg-dim'>({shareLog.length})</span>
          </button>
        </div>

        {/* -- sites -- */}
        {activeTab === 'sites' && (
          <section className='flex flex-col'>
            {sites.length === 0 ? (
              <div className='flex flex-col items-center py-6 text-center text-fg-muted'>
                <span className='i-lucide-globe size-6 mb-2' />
                <p className='text-body font-mono'>no sites yet</p>
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
                  onToggleExpand={() =>
                    setExpandedSite(expandedSite === site.origin ? null : site.origin)
                  }
                  confirming={confirming?.origin === site.origin ? confirming.action : null}
                  onConfirm={action => setConfirming({ origin: site.origin, action })}
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
          <section className='flex flex-col'>
            {shareLog.length === 0 ? (
              <div className='flex flex-col items-center py-6 text-fg-muted'>
                <span className='i-lucide-scroll-text size-6 mb-2' />
                <p className='text-body font-mono'>no keys shared yet</p>
              </div>
            ) : (
              [...shareLog].reverse().map((record, i) => (
                <button
                  key={`${record.sharedWith}-${record.sharedAt}-${i}`}
                  onClick={() => copy(record.publicKey, `log-${i}`)}
                  title='copy shared key'
                  className={`flex items-baseline justify-between gap-2 py-1.5 text-left border-b border-border-soft last:border-0 text-fg-muted hover:text-fg-high transition-colors ${focusRing}`}
                >
                  <span className='text-label font-mono truncate'>
                    {displayOrigin(record.sharedWith)}
                  </span>
                  <span className='text-label text-fg-dim shrink-0 font-mono tabular'>
                    {copied === `log-${i}` ? 'copied' : shortDate(record.sharedAt)}
                  </span>
                </button>
              ))
            )}
          </section>
        )}

        {/* -- links - passwords is the only destination that lives nowhere
            else. contacts has its own drawer entry; the pro upsell lives in
            the drawer footer + settings. Gated off for now (PASSWORD_GENERATOR). */}
        {PASSWORD_GENERATOR && (
          <>
            <hr className='border-border-soft' />
            <div className='flex flex-col gap-2'>
              <button
                onClick={() => navigate(PopupPath.PASSWORDS)}
                className={`flex items-center justify-between text-body font-mono text-fg hover:text-fg-high transition-colors ${focusRing}`}
              >
                <span className='flex items-center gap-1.5'>
                  <span className='i-lucide-key-round size-3.5' />
                  passwords
                </span>
                <span className='i-lucide-chevron-right size-3.5 text-fg-dim' />
              </button>
            </div>
          </>
        )}
      </div>
    </SettingsScreen>
  );
};

/* -- qr -- */
const QrCanvas = ({ data, size }: { data: string; size: number }) => {
  const ref = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas || !data) {
        return;
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const QRCode = require('qrcode');
        QRCode.toCanvas(canvas, data, {
          width: size,
          margin: 1,
          color: { dark: '#000', light: '#fff' },
          errorCorrectionLevel: 'L',
        });
      } catch {
        /* */
      }
    },
    [data, size],
  );
  return <canvas ref={ref} />;
};

/* -- site row -- */
const ALL_CAPS: Capability[] = [
  'connect',
  'sign_identity',
  'send_tx',
  'export_fvk',
  'view_contacts',
  'view_history',
  'frost',
  'auto_sign',
];

const SiteRow = ({
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
  onSitesChanged,
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
  const [capsOpen, setCapsOpen] = useState(false);

  const handleCapToggle = async (cap: Capability, enabled: boolean) => {
    if (enabled) {
      await grantCapability(site.origin, cap);
    } else {
      await denyCapability(site.origin, cap);
    }
    onSitesChanged();
  };

  const handleRevoke = () => {
    revokeOriginFull(site.origin);
    onSitesChanged();
  };

  return (
    <div
      className={`border-b border-border-soft last:border-0 ${!site.connected ? 'opacity-40' : ''}`}
    >
      {/* header - the quiet default row */}
      <button
        onClick={onToggleExpand}
        className={`w-full flex items-center justify-between gap-2 py-2 text-left ${focusRing}`}
      >
        <div className='flex items-center gap-2 min-w-0'>
          <span
            className={`size-3.5 shrink-0 ${
              site.connected ? 'i-lucide-link text-network-accent' : 'i-lucide-unlink text-fg-dim'
            }`}
          />
          {editingLabel === site.origin ? (
            <input
              autoFocus
              value={labelInput}
              onChange={e => setLabelInput(e.target.value)}
              onBlur={() => void saveLabel(site.origin, labelInput)}
              onClick={e => e.stopPropagation()}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  void saveLabel(site.origin, labelInput);
                }
                if (e.key === 'Escape') {
                  setEditingLabel(null);
                }
              }}
              className={`text-body font-mono bg-transparent border-b border-border-soft outline-none text-fg ${focusRing}`}
              placeholder='label...'
            />
          ) : (
            <span className='text-body font-mono text-fg truncate'>
              {siteLabels[site.origin] || displayOrigin(site.origin)}
            </span>
          )}
          {!isSiteMode && (
            <span className='text-label text-warning font-mono px-1 border border-warning/40'>
              cross
            </span>
          )}
        </div>
        <div className='flex items-center gap-2 shrink-0 text-label font-mono text-fg-muted'>
          {site.lastShared && (
            <span className='text-fg-dim tabular'>{shortDate(site.lastShared.sharedAt)}</span>
          )}
          <span>
            {site.perms ? `${site.perms.granted.length} caps` : ''}
            {isSiteMode && rotation > 0 ? ` #${rotation}` : ''}
          </span>
          <span
            className={`size-3.5 text-fg-dim transition-transform ${expanded ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'}`}
          />
        </div>
      </button>

      {/* expanded - all per-site controls, revealed on demand */}
      {expanded && (
        <div className='pb-3 pl-7 flex flex-col gap-2.5 text-body font-mono text-fg'>
          {/* last shared key */}
          {site.lastShared && (
            <button
              onClick={() => onCopy(site.lastShared!.publicKey, site.origin)}
              title='copy shared key'
              className={`flex items-center gap-1 text-left text-label text-fg-muted hover:text-fg-high transition-colors ${focusRing}`}
            >
              <span
                className={`size-3 ${copied === site.origin ? 'i-lucide-check text-success' : 'i-lucide-copy'}`}
              />
              <span className='truncate'>{site.lastShared.publicKey.slice(0, 36)}...</span>
            </button>
          )}

          {/* identity mode toggle */}
          <div className='flex flex-col gap-1.5'>
            <span className='text-label text-fg-muted lowercase'>identity mode</span>
            <div className='flex'>
              <button
                onClick={() =>
                  !isSiteMode ? void onUpdatePref(site.origin, undefined) : undefined
                }
                title='site-specific key (unlinkable)'
                className={`flex items-center gap-1 px-2 py-0.5 border text-label transition-colors ${focusRing} ${
                  isSiteMode
                    ? 'bg-elev-2 border-fg-dim text-fg-high'
                    : 'border-border-soft text-fg-muted hover:text-fg-high'
                }`}
              >
                <span className='i-lucide-shield-check size-3' />
                unique
              </button>
              <button
                onClick={() => (isSiteMode ? onConfirm('cross-site') : undefined)}
                title='shared key across sites (linkable)'
                className={`flex items-center gap-1 px-2 py-0.5 border border-l-0 text-label transition-colors ${focusRing} ${
                  !isSiteMode
                    ? 'bg-warning/15 border-warning/40 text-warning'
                    : 'border-border-soft text-fg-muted hover:text-fg-high'
                }`}
              >
                <span className='i-lucide-link size-3' />
                shared
              </button>
            </div>
            {!isSiteMode && (
              <span className='flex items-center gap-1 text-label text-warning'>
                <span className='i-lucide-triangle-alert size-3' />
                sites with a shared key can link your sessions
              </span>
            )}
          </div>

          {/* rotation control */}
          {isSiteMode && (
            <div className='flex flex-col gap-1'>
              <span className='text-label text-fg-muted lowercase'>key rotation</span>
              <div className='flex items-center gap-1.5 text-label'>
                <button
                  onClick={() =>
                    rotation > 0
                      ? void onUpdatePref(site.origin, { ...site.pref, rotation: rotation - 1 })
                      : undefined
                  }
                  disabled={rotation === 0}
                  title='remove a rotation'
                  className={`grid size-5 place-items-center border border-border-soft text-fg-muted hover:text-fg-high disabled:opacity-20 transition-colors ${focusRing}`}
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
                  className={`w-8 bg-transparent border border-border-soft text-center text-label font-mono py-0.5 outline-none text-fg ${focusRing}`}
                />
                <button
                  onClick={() => onConfirm('rotate')}
                  title='rotate to a fresh key'
                  className={`grid size-5 place-items-center border border-border-soft text-fg-muted hover:text-fg-high transition-colors ${focusRing}`}
                >
                  <span className='i-lucide-plus size-3' />
                </button>
                <span className='ml-1 text-fg-muted'>
                  {rotation === 0 ? 'original key' : `rotated ${rotation}x`}
                </span>
              </div>
            </div>
          )}

          {/* quick actions */}
          <div className='flex items-center gap-3 pt-1 text-label'>
            <button
              onClick={() => {
                setEditingLabel(site.origin);
                setLabelInput(siteLabels[site.origin] ?? '');
              }}
              className={`flex items-center gap-1 text-fg-muted hover:text-fg-high transition-colors ${focusRing}`}
            >
              <span className='i-lucide-tag size-3' />
              label
            </button>
            {site.perms && (
              <button
                onClick={() => setCapsOpen(!capsOpen)}
                className={`flex items-center gap-1 text-fg-muted hover:text-fg-high transition-colors ${focusRing}`}
              >
                <span className='i-lucide-shield size-3' />
                {capsOpen ? 'hide' : 'permissions'}
              </button>
            )}
            <button
              onClick={() => handleRevoke()}
              className={`flex items-center gap-1 text-error transition-colors hover:brightness-125 ${focusRing}`}
            >
              <span className='i-lucide-x size-3' />
              revoke
            </button>
          </div>

          {/* capabilities */}
          {capsOpen && site.perms && (
            <div className='flex flex-col gap-0.5 pl-2 border-l border-border-soft text-label'>
              {ALL_CAPS.map(cap => (
                <label key={cap} className='flex items-center justify-between py-0.5'>
                  <span>{CAPABILITY_META[cap].label.toLowerCase()}</span>
                  <input
                    type='checkbox'
                    checked={site.perms!.granted.includes(cap)}
                    onChange={e => void handleCapToggle(cap, e.target.checked)}
                    className={`size-3 ${focusRing}`}
                  />
                </label>
              ))}
            </div>
          )}

          {/* confirmations */}
          {confirming === 'cross-site' && (
            <div className='pl-2 border-l-2 border-warning/40 text-label'>
              <p className='text-warning mb-1.5'>
                same key across all origins. sites can link your sessions.
              </p>
              <div className='flex gap-3'>
                <button
                  onClick={onCancelConfirm}
                  className={`text-fg-muted hover:text-fg-high transition-colors ${focusRing}`}
                >
                  cancel
                </button>
                <button
                  onClick={() =>
                    void onUpdatePref(site.origin, {
                      mode: 'cross-site',
                      rotation: 0,
                      identity: site.pref.identity,
                    })
                  }
                  className={`text-warning transition-colors hover:brightness-125 ${focusRing}`}
                >
                  confirm
                </button>
              </div>
            </div>
          )}
          {confirming === 'rotate' && (
            <div className='pl-2 border-l-2 border-border-soft text-label'>
              <p className='mb-1.5'>
                new key #{rotation + 1}. old key #{rotation} is abandoned - site keeps whatever key
                it had.
              </p>
              <div className='flex gap-3'>
                <button
                  onClick={onCancelConfirm}
                  className={`text-fg-muted hover:text-fg-high transition-colors ${focusRing}`}
                >
                  cancel
                </button>
                <button
                  onClick={() =>
                    void onUpdatePref(site.origin, {
                      mode: 'site',
                      rotation: rotation + 1,
                      identity: site.pref.identity,
                    })
                  }
                  className={`text-fg hover:text-fg-high transition-colors ${focusRing}`}
                >
                  rotate
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
