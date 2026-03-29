import { useState, useEffect } from 'react';
import { OriginRecord, UserChoice } from '@repo/storage-chrome/records';
import { Button } from '@repo/ui/components/ui/button';
import { DisplayOriginURL } from '../../../../shared/components/display-origin-url';
import { localExtStorage } from '@repo/storage-chrome/local';
import { useStore } from '../../../../state';
import { selectPenumbraWallets, selectActivePenumbraIndex, selectZcashWallets, selectActiveZcashIndex } from '../../../../state/wallets';
import type { ZidSitePreference } from '../../../../state/identity';
import { getOriginPermissions } from '@repo/storage-chrome/origin';
import { CAPABILITY_META, type Capability, type OriginPermissions } from '@repo/storage-chrome/capabilities';
import { cn } from '@repo/ui/lib/utils';

const useZidPref = (origin: string) => {
  const [pref, setPref] = useState<ZidSitePreference | undefined>();

  useEffect(() => {
    void localExtStorage.get('zidPreferences').then(prefs => {
      const raw = prefs?.[origin] as Partial<ZidSitePreference> | undefined;
      if (raw) {
        setPref({
          mode: raw.mode === 'cross-site' ? 'cross-site' : 'site',
          rotation: raw.rotation ?? 0,
          identity: raw.identity ?? 'default',
        });
      }
    });
  }, [origin]);

  const update = async (next: ZidSitePreference | undefined) => {
    const prefs = (await localExtStorage.get('zidPreferences')) ?? {};
    if (next) {
      prefs[origin] = next;
    } else {
      delete prefs[origin];
    }
    await localExtStorage.set('zidPreferences', prefs);
    setPref(next);
  };

  return { pref, update };
};

/**
 * look up the zid we last shared with this site from the share log.
 * avoids touching the mnemonic - the pubkey was recorded at sign time.
 */
const useSharedZid = (origin: string) => {
  const [address, setAddress] = useState<string | null>(null);
  const [pubkey, setPubkey] = useState<string | null>(null);

  useEffect(() => {
    void localExtStorage.get('zidShareLog').then(log => {
      if (!log) return;
      // find most recent share with this origin
      const entries = log.filter(r => r.sharedWith === origin);
      const latest = entries[entries.length - 1];
      if (latest) {
        setPubkey(latest.publicKey);
        setAddress('zid' + latest.publicKey.slice(0, 16));
      }
    });
  }, [origin]);

  return { address, pubkey };
};

const useOriginPermissions = (origin: string) => {
  const [perms, setPerms] = useState<OriginPermissions | undefined>();

  useEffect(() => {
    void getOriginPermissions(origin).then(setPerms);
  }, [origin]);

  return perms;
};

const ALL_CAPABILITIES: Capability[] = [
  'connect', 'sign_identity', 'send_tx', 'export_fvk',
  'view_contacts', 'view_history', 'frost', 'auto_sign',
];

const CapabilityToggle = ({
  cap,
  granted,
  onToggle,
}: {
  cap: Capability;
  granted: boolean;
  onToggle: (cap: Capability, enabled: boolean) => void;
}) => {
  const meta = CAPABILITY_META[cap];
  return (
    <label className='flex items-center justify-between gap-2 py-1'>
      <div className='flex items-center gap-1.5'>
        <span className={cn(
          'text-[10px]',
          meta.risk === 'low' && 'text-muted-foreground',
          meta.risk === 'medium' && 'text-yellow-400',
          meta.risk === 'high' && 'text-orange-400',
          meta.risk === 'critical' && 'text-red-400',
        )}>
          {meta.label}
        </span>
      </div>
      <input
        type='checkbox'
        checked={granted}
        onChange={e => onToggle(cap, e.target.checked)}
        className='h-3 w-3 accent-primary'
      />
    </label>
  );
};

export const KnownSite = ({
  site,
  discard,
}: {
  site: OriginRecord;
  discard: (d: { origin: string }) => Promise<void>;
}) => {
  const { pref, update } = useZidPref(site.origin);
  const isApproved = site.choice === UserChoice.Approved;
  const { address: zidAddress, pubkey: zidPubkey } = useSharedZid(site.origin);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [capsExpanded, setCapsExpanded] = useState(false);
  const [confirming, setConfirming] = useState<'global' | 'rotate' | null>(null);
  const perms = useOriginPermissions(site.origin);
  const toggleCapability = useStore(state => state.connectedSites.toggleCapability);

  // network addresses - show all enabled, not just active network
  const penumbraWallets = useStore(selectPenumbraWallets);
  const penumbraIdx = useStore(selectActivePenumbraIndex);
  const zcashWallets = useStore(selectZcashWallets);
  const zcashIdx = useStore(selectActiveZcashIndex);
  const penumbraAddr = penumbraWallets[penumbraIdx]?.id;
  const zcashAddr = zcashWallets[zcashIdx]?.address;

  const copyZid = () => {
    if (!zidPubkey) return;
    void navigator.clipboard.writeText(zidPubkey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // default is site-specific. toggle switches to global (opt-in).
  const isSiteMode = !pref || pref.mode === 'site';
  const rotation = pref?.rotation ?? 0;

  const toggleMode = () => {
    if (isSiteMode) {
      // switching to global is privacy-reducing - confirm first
      setConfirming('global');
    } else {
      void update(undefined); // back to site-specific (default)
      setConfirming(null);
    }
  };

  const confirmGlobal = () => {
    void update({ mode: 'cross-site', rotation: 0, identity: pref?.identity ?? 'default' });
    setConfirming(null);
  };

  const rotate = () => {
    setConfirming('rotate');
  };

  const confirmRotate = () => {
    void update({ mode: 'site', rotation: rotation + 1, identity: pref?.identity ?? 'default' });
    setConfirming(null);
  };

  const handleCapToggle = (cap: Capability, enabled: boolean) => {
    void toggleCapability(site.origin, cap, enabled);
  };

  return (
    <div key={site.origin} role='listitem' className='flex flex-col gap-1'>
      <div className='flex items-center justify-between'>
        {isApproved && (
          <a href={site.origin} target='_blank' rel='noreferrer' className='truncate'>
            <DisplayOriginURL url={new URL(site.origin)} />
          </a>
        )}
        {site.choice === UserChoice.Denied && (
          <span className='truncate brightness-75'>
            <DisplayOriginURL url={new URL(site.origin)} />
          </span>
        )}
        {site.choice === UserChoice.Ignored && (
          <span className='truncate line-through decoration-red decoration-wavy brightness-75'>
            <DisplayOriginURL url={new URL(site.origin)} />
          </span>
        )}

        <div className='flex items-center gap-1'>
          <Button
            aria-description='Remove'
            className='h-auto bg-transparent'
            onClick={() => void discard(site)}
          >
            <span className='i-lucide-trash-2 h-4 w-4 text-muted-foreground' />
          </Button>
        </div>
      </div>

      {/* connection details for approved sites */}
      {isApproved && (
        <div className='flex flex-col gap-1.5 pl-1 pb-2'>
          {/* per-capability toggles */}
          <button
            onClick={() => setCapsExpanded(!capsExpanded)}
            className='flex items-center gap-1 text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors'
          >
            <span className={`i-lucide-chevron-${capsExpanded ? 'down' : 'right'} h-2.5 w-2.5`} />
            capabilities ({perms?.granted.length ?? 0} granted)
          </button>
          {capsExpanded && (
            <div className='flex flex-col gap-0.5 pl-4 border-l border-border/20'>
              {ALL_CAPABILITIES.map(cap => (
                <CapabilityToggle
                  key={cap}
                  cap={cap}
                  granted={perms?.granted.includes(cap) ?? false}
                  onToggle={handleCapToggle}
                />
              ))}
            </div>
          )}

          {/* zid from share log - no mnemonic access needed */}
          {zidAddress ? (
            <button
              onClick={copyZid}
              className='flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground/70 hover:text-foreground transition-colors'
              title={copied ? 'copied' : 'copy full pubkey'}
            >
              <span className='i-lucide-fingerprint h-3 w-3 shrink-0' />
              <span className='truncate'>{zidAddress}</span>
              {copied && <span className='text-green-500 shrink-0'>copied</span>}
            </button>
          ) : (
            <span className='flex items-center gap-1.5 text-[10px] text-muted-foreground/40'>
              <span className='i-lucide-fingerprint h-3 w-3 shrink-0' />
              no zid shared yet
            </span>
          )}

          {/* network addresses - show what this site can see */}
          {(penumbraAddr || zcashAddr) && (
            <button
              onClick={() => setExpanded(!expanded)}
              className='flex items-center gap-1 text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors'
            >
              <span className={`i-lucide-chevron-${expanded ? 'down' : 'right'} h-2.5 w-2.5`} />
              addresses
            </button>
          )}
          {expanded && (
            <div className='flex flex-col gap-1 pl-4'>
              {penumbraAddr && (
                <div className='flex items-center gap-1.5 text-[10px] text-muted-foreground/60'>
                  <span className='shrink-0'>penumbra</span>
                  <span className='font-mono truncate'>{penumbraAddr.slice(0, 24)}...</span>
                </div>
              )}
              {zcashAddr && (
                <div className='flex items-center gap-1.5 text-[10px] text-muted-foreground/60'>
                  <span className='shrink-0'>zcash</span>
                  <span className='font-mono truncate'>{zcashAddr.slice(0, 24)}...</span>
                </div>
              )}
            </div>
          )}

          {/* identity mode toggle + rotation */}
          <div className='flex items-center gap-2'>
            <button
              onClick={toggleMode}
              className='flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors'
            >
              <span className={`${isSiteMode ? 'i-lucide-shield' : 'i-lucide-globe'} h-3 w-3`} />
              {isSiteMode ? 'site identity' : 'global identity'}
            </button>
            {isSiteMode && (
              <>
                <span className='text-[10px] text-muted-foreground/40'>
                  #{rotation}
                </span>
                <button
                  onClick={rotate}
                  className='flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors'
                  title='rotate identity - gives this site a new zid'
                >
                  <span className='i-lucide-refresh-cw h-2.5 w-2.5' />
                  rotate
                </button>
              </>
            )}
          </div>

          {/* confirmation dialogs */}
          {confirming === 'global' && (
            <div className='rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-2.5 flex flex-col gap-2'>
              <p className='text-[10px] text-yellow-400'>
                switching to global identity lets this site link your activity
                with every other site using your global zid.
              </p>
              <div className='flex gap-2'>
                <button
                  onClick={() => setConfirming(null)}
                  className='flex-1 rounded border border-border/40 py-1 text-[10px] text-muted-foreground hover:bg-muted/50 transition-colors'
                >
                  cancel
                </button>
                <button
                  onClick={confirmGlobal}
                  className='flex-1 rounded border border-yellow-500/30 py-1 text-[10px] text-yellow-400 hover:bg-yellow-500/10 transition-colors'
                >
                  use global
                </button>
              </div>
            </div>
          )}

          {confirming === 'rotate' && (
            <div className='rounded-lg border border-border/40 bg-card p-2.5 flex flex-col gap-2'>
              <p className='text-[10px] text-muted-foreground'>
                this creates a new identity for this site. the site keeps
                your old zid - rotation only affects future signatures.
              </p>
              <div className='flex gap-2'>
                <button
                  onClick={() => setConfirming(null)}
                  className='flex-1 rounded border border-border/40 py-1 text-[10px] text-muted-foreground hover:bg-muted/50 transition-colors'
                >
                  cancel
                </button>
                <button
                  onClick={confirmRotate}
                  className='flex-1 rounded border border-primary/25 py-1 text-[10px] text-primary hover:bg-primary/10 transition-colors'
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
