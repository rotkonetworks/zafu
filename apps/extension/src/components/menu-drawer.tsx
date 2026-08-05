/**
 * slide-out menu drawer
 * includes navigation, about info, and donation
 */

import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../state';
import { getZidIndex, getZidPins } from '../state/identity';
import { selectLock, selectActiveNetwork, selectEffectiveKeyInfo } from '../state/keyring';
import { isPro } from '../state/license';
import { isIdentityEnabled } from '../state/privacy';
import { PopupPath } from '../routes/popup/paths';
import { cn } from '@repo/ui/lib/utils';
import { isSidePanel } from '../utils/popup-detection';
import { hasFeature } from '../config/networks';
import { SUBSCRIBE_ENABLED } from '../config/feature-flags';

/** donation addresses per network */
const DONATE: Record<string, { address: string; name: string }> = {
  zcash: {
    address:
      'u153khs43zxz6hcnlwnut77knyqmursnutmungxjxd7khruunhj77ea6tmpzxct9wzlgen66jxwc93ea053j22afkktu7hrs9rmsz003h3',
    name: 'zafu / rotko networks',
  },
};

interface MenuDrawerProps {
  open: boolean;
  onClose: () => void;
}

export const MenuDrawer = ({ open, onClose }: MenuDrawerProps) => {
  const navigate = useNavigate();
  const lock = useStore(selectLock);
  const activeNetwork = useStore(selectActiveNetwork);
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const pro = useStore(isPro);
  const identityEnabled = useStore(isIdentityEnabled);
  const inSidePanel = isSidePanel();
  const [zidCopied, setZidCopied] = useState(false);

  // ONLY the active wallet's ZID. Never another wallet's.
  //
  // This used to fall back to `allKeyInfos.find(k => k.insensitive.zid)` when
  // the selected wallet had none — which always resolved to the same first
  // wallet, so the drawer appeared to show one fixed identity no matter which
  // wallet you switched to. Worse than a wrong label: the button copies this
  // pubkey to the clipboard, so a user could hand a site the identity of a
  // wallet they had deliberately switched away from.
  //
  // A wallet without an identity now shows nothing rather than someone
  // else's.
  const zidPubkey = keyInfo?.insensitive?.['zid'] as string | undefined;
  const zidAddress = zidPubkey ? 'zid' + zidPubkey.slice(0, 16) : undefined;

  // Show the pinned NAME of the current generation when one is set. A raw
  // zid1b5a0a6ae5ccc64 tells the user nothing about which identity they are
  // presenting, and identities are the thing it is most costly to confuse —
  // the whole point of rotating is that generations are meant to be distinct.
  const [zidLabel, setZidLabel] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [idx, pins] = await Promise.all([getZidIndex(), getZidPins()]);
        const pin = pins.find(p => p.index === idx);
        if (!cancelled) {
          setZidLabel(pin?.label);
        }
      } catch {
        // a missing pin is the normal case, not an error
      }
    })();
    return () => {
      cancelled = true;
    };
    // re-read when the displayed identity changes
  }, [zidPubkey]);

  const handleLock = () => {
    lock();
    onClose();
    navigate(PopupPath.LOGIN);
  };

  const handleOpenPopupWindow = async () => {
    onClose();
    try {
      await chrome.windows.create({
        url: chrome.runtime.getURL('popup.html'),
        type: 'popup',
        width: 400,
        height: 628,
      });
      window.close();
    } catch (e) {
      console.error('Failed to open popup window:', e);
    }
  };

  const donation = activeNetwork ? DONATE[activeNetwork] : undefined;

  const handleDonate = useCallback(() => {
    if (!donation) {
      return;
    }
    onClose();
    navigate(PopupPath.SEND, { state: { prefillRecipient: donation.address } });
  }, [donation, navigate, onClose]);

  if (!open) {
    return null;
  }

  // Destinations demoted from the bottom-tabs rail (which now shows
  // only Home + Inbox). Each is gated by the active network's feature
  // set so we never offer a destination the network can't fulfill.
  const onMultisigWallet = keyInfo?.type === 'frost-multisig';
  const showMultisig = activeNetwork === 'zcash' && (onMultisigWallet || pro);

  interface MenuItem {
    icon: string;
    label: string;
    onClick: () => void;
    className?: string;
  }
  const networkDestinations: MenuItem[] = [
    hasFeature(activeNetwork, 'stake') && {
      icon: 'i-lucide-layers',
      label: 'stake',
      onClick: () => {
        navigate(PopupPath.STAKE);
        onClose();
      },
    },
    hasFeature(activeNetwork, 'swap') && {
      icon: 'i-lucide-arrow-left-right',
      label: 'swap',
      onClick: () => {
        navigate(PopupPath.SWAP);
        onClose();
      },
    },
    // vote lives in the bottom tabs (feature-gated) - no drawer duplicate.
    // pool notes has no drawer entry either: the home balance card links
    // straight into the per-pool notes view.
    showMultisig && {
      icon: 'i-lucide-shield',
      label: 'multisig',
      onClick: () => {
        navigate(PopupPath.MULTISIG);
        onClose();
      },
    },
  ].filter(Boolean) as MenuItem[];

  // Grouped so the drawer reads top→bottom as:
  //   network features → account/identity → app settings → session.
  // A new user looking for 'lock' doesn't have to scan through stake
  // and swap to find it; a returning user looking for 'stake' isn't
  // looking past 'settings' to find it.
  const accountItems: MenuItem[] = [
    identityEnabled && {
      icon: 'i-lucide-fingerprint',
      label: 'identity',
      onClick: () => {
        navigate(PopupPath.IDENTITY);
        onClose();
      },
    },
    // contacts gets its own row — it's a daily-use destination (pick a
    // recipient, share a card), not an identity sub-setting; burying it
    // behind the identity page made it two taps and undiscoverable.
    identityEnabled && {
      icon: 'i-lucide-users',
      label: 'contacts',
      onClick: () => {
        navigate(PopupPath.CONTACTS);
        onClose();
      },
    },
    {
      icon: 'i-lucide-wallet',
      label: 'wallets',
      onClick: () => {
        navigate(PopupPath.SETTINGS_WALLETS);
        onClose();
      },
    },
  ].filter(Boolean) as MenuItem[];

  // networks moved into settings (wallet group) - the drawer stays
  // switches + actions only.
  const appItems: MenuItem[] = [
    {
      icon: 'i-lucide-settings',
      label: 'settings',
      onClick: () => {
        navigate(PopupPath.SETTINGS);
        onClose();
      },
    },
  ];

  const sessionItems: MenuItem[] = [
    ...(inSidePanel
      ? [
          {
            icon: 'i-lucide-panel-right',
            label: 'open as popup',
            onClick: handleOpenPopupWindow,
          },
        ]
      : []),
    {
      icon: 'i-lucide-lock',
      label: 'lock',
      onClick: handleLock,
      className: 'text-destructive',
    },
  ];

  // Each non-empty group is rendered separately with a thin top
  // border (skipped for the first). Empty groups (e.g. networkDestinations
  // when the current network has no extra features) collapse without
  // leaving a dangling divider.
  const menuGroups: MenuItem[][] = [
    networkDestinations,
    accountItems,
    appItems,
    sessionItems,
  ].filter(g => g.length > 0);

  return (
    <>
      {/* backdrop */}
      <div className='fixed inset-0 z-50 bg-black/60 backdrop-blur-sm' onClick={onClose} />

      {/* drawer */}
      <div className='fixed right-0 top-0 bottom-0 z-50 w-64 bg-canvas border-l border-border-soft shadow-xl flex flex-col'>
        {/* header */}
        <div className='flex items-center justify-between px-4 py-3 border-b border-border-soft'>
          <span className='text-data text-fg-high'>zafu</span>
          <button
            onClick={onClose}
            className='p-1 rounded-md text-fg-muted hover:text-fg-high hover:bg-elev-1 transition-colors'
          >
            <span className='i-lucide-x h-4 w-4' />
          </button>
        </div>

        {/* zid - hidden when identity feature is disabled */}
        {zidAddress && identityEnabled && (
          <button
            onClick={() => {
              void navigator.clipboard.writeText(zidPubkey!);
              setZidCopied(true);
              setTimeout(() => setZidCopied(false), 1500);
            }}
            className='mx-4 mt-3 flex items-center gap-2 rounded-md border border-border-soft px-3 py-2 text-left hover:bg-elev-1 transition-colors'
          >
            <span className='i-lucide-fingerprint h-3.5 w-3.5 text-fg-dim' />
            <span className='flex min-w-0 flex-col'>
              {zidLabel && (
                <span className='truncate text-xs text-fg-high lowercase'>{zidLabel}</span>
              )}
              <span className='text-xs tabular text-fg-muted truncate'>{zidAddress}</span>
            </span>
            <span className='text-label text-fg-dim ml-auto lowercase shrink-0'>
              {zidCopied ? 'copied' : 'zid'}
            </span>
          </button>
        )}

        {/* menu items — grouped, with thin top border between groups */}
        <nav className='p-2'>
          {menuGroups.map((group, gi) => (
            <div key={gi} className={cn(gi > 0 && 'mt-1 pt-1 border-t border-border-soft/40')}>
              {group.map((item, i) => (
                <button
                  key={i}
                  onClick={item.onClick}
                  className={cn(
                    'flex w-full items-center gap-3 px-3 py-2.5 rounded-md text-data text-fg hover:text-fg-high transition-colors hover:bg-elev-1',
                    item.className,
                  )}
                >
                  <span className={cn(item.icon, 'h-4 w-4')} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        {/* footer — upgrade (if free) + donate (always offered when available) + links */}
        <div className='mt-auto flex flex-col gap-3 border-t border-border-soft px-4 py-4'>
          {!pro && SUBSCRIBE_ENABLED && (
            <button
              onClick={() => {
                navigate(PopupPath.SUBSCRIBE);
                onClose();
              }}
              className='flex w-full items-center justify-center gap-2 px-3 py-2 rounded-md bg-zigner-gold text-zigner-dark hover:bg-zigner-gold-light transition-colors text-data lowercase'
            >
              <span className='i-lucide-zap h-3.5 w-3.5' />
              <span>upgrade to pro</span>
            </button>
          )}
          {donation && (
            <button
              onClick={handleDonate}
              className='flex w-full items-center justify-center gap-2 px-3 py-2 rounded-md border border-border-soft text-data text-fg-muted hover:text-fg-high hover:bg-elev-1 transition-colors'
            >
              <span className='i-lucide-heart h-3.5 w-3.5' />
              <span>donate {activeNetwork}</span>
            </button>
          )}

          <div className='flex items-center justify-between text-label text-fg-dim lowercase'>
            <a
              href='https://zafu.pro'
              target='_blank'
              rel='noopener noreferrer'
              className='flex items-center gap-1 transition-colors hover:text-fg-high'
            >
              <span className='i-lucide-globe h-3 w-3' />
              zafu.pro
            </a>
            <a
              href='https://github.com/rotkonetworks/zafu'
              target='_blank'
              rel='noopener noreferrer'
              className='flex items-center gap-1 transition-colors hover:text-fg-high'
            >
              <span className='i-lucide-code h-3 w-3' />
              github
            </a>
            <a
              href='https://zigner.zafu.pro'
              target='_blank'
              rel='noopener noreferrer'
              className='flex items-center gap-1 transition-colors hover:text-fg-high'
            >
              <span className='i-lucide-smartphone h-3 w-3' />
              zigner
            </a>
            <a
              href='https://dex.rotko.net'
              target='_blank'
              rel='noopener noreferrer'
              className='flex items-center gap-1 transition-colors hover:text-fg-high'
            >
              <span className='i-lucide-arrow-left-right h-3 w-3' />
              dex
            </a>
          </div>
        </div>
      </div>
    </>
  );
};
