/**
 * slide-out menu drawer
 * includes navigation, about info, and donation
 */

import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../state';
import { selectLock, selectActiveNetwork, selectEffectiveKeyInfo, selectKeyInfos } from '../state/keyring';
import { isPro } from '../state/license';
import { PopupPath } from '../routes/popup/paths';
import { cn } from '@repo/ui/lib/utils';
import { isSidePanel } from '../utils/popup-detection';
import { hasFeature } from '../config/networks';

/** donation addresses per network */
const DONATE: Record<string, { address: string; name: string }> = {
  zcash: {
    address: 'u153khs43zxz6hcnlwnut77knyqmursnutmungxjxd7khruunhj77ea6tmpzxct9wzlgen66jxwc93ea053j22afkktu7hrs9rmsz003h3',
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
  const allKeyInfos = useStore(selectKeyInfos);
  const pro = useStore(isPro);
  const inSidePanel = isSidePanel();
  const [zidCopied, setZidCopied] = useState(false);

  // fall back to any keyInfo's ZID if active one doesn't have it
  const zidPubkey = (keyInfo?.insensitive?.['zid'] ?? allKeyInfos.find(k => k.insensitive?.['zid'])?.insensitive?.['zid']) as string | undefined;
  const zidAddress = zidPubkey ? 'zid' + zidPubkey.slice(0, 16) : undefined;

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
    if (!donation) return;
    onClose();
    navigate(PopupPath.SEND, { state: { prefillRecipient: donation.address } });
  }, [donation, navigate, onClose]);

  if (!open) return null;

  // Destinations demoted from the bottom-tabs rail (which now shows
  // only Home + Inbox). Each is gated by the active network's feature
  // set so we never offer a destination the network can't fulfill.
  const onMultisigWallet = keyInfo?.type === 'frost-multisig';
  const showMultisig = activeNetwork === 'zcash' && (onMultisigWallet || pro);

  type MenuItem = { icon: string; label: string; onClick: () => void; className?: string };
  const networkDestinations: MenuItem[] = ([
    hasFeature(activeNetwork, 'stake') && {
      icon: 'i-lucide-layers',
      label: 'stake',
      onClick: () => { navigate(PopupPath.STAKE); onClose(); },
    },
    hasFeature(activeNetwork, 'swap') && {
      icon: 'i-lucide-arrow-left-right',
      label: 'swap',
      onClick: () => { navigate(PopupPath.SWAP); onClose(); },
    },
    hasFeature(activeNetwork, 'vote') && {
      icon: 'i-lucide-vote',
      label: 'vote',
      onClick: () => { navigate(PopupPath.VOTE); onClose(); },
    },
    showMultisig && {
      icon: 'i-lucide-shield',
      label: 'multisig',
      onClick: () => { navigate(PopupPath.MULTISIG); onClose(); },
    },
  ].filter(Boolean) as MenuItem[]);

  // Grouped so the drawer reads top→bottom as:
  //   network features → account/identity → app settings → session.
  // A new user looking for 'lock' doesn't have to scan through stake
  // and swap to find it; a returning user looking for 'stake' isn't
  // looking past 'settings' to find it.
  const accountItems: MenuItem[] = [
    {
      icon: 'i-lucide-fingerprint',
      label: 'identity & contacts',
      onClick: () => { navigate(PopupPath.IDENTITY); onClose(); },
    },
    {
      icon: 'i-lucide-wallet',
      label: 'wallets',
      onClick: () => { navigate(PopupPath.SETTINGS_WALLETS); onClose(); },
    },
  ];

  const appItems: MenuItem[] = [
    {
      icon: 'i-lucide-globe',
      label: 'networks',
      onClick: () => { navigate(PopupPath.SETTINGS_NETWORKS); onClose(); },
    },
    {
      icon: 'i-lucide-settings',
      label: 'settings',
      onClick: () => { navigate(PopupPath.SETTINGS); onClose(); },
    },
  ];

  const sessionItems: MenuItem[] = [
    ...(inSidePanel
      ? [{
          icon: 'i-lucide-panel-right',
          label: 'open as popup',
          onClick: handleOpenPopupWindow,
        }]
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
      <div
        className='fixed inset-0 z-50 bg-black/60 backdrop-blur-sm'
        onClick={onClose}
      />

      {/* drawer */}
      <div className='fixed right-0 top-0 bottom-0 z-50 w-64 bg-canvas border-l border-border-soft shadow-xl flex flex-col'>
        {/* header */}
        <div className='flex items-center justify-between px-4 py-3 border-b border-border-soft'>
          <span className='text-[13px] text-fg-high'>zafu</span>
          <button onClick={onClose} className='p-1 rounded-md text-fg-muted hover:text-fg-high hover:bg-elev-1 transition-colors'>
            <span className='i-lucide-x h-4 w-4' />
          </button>
        </div>

        {/* zid */}
        {zidAddress && (
          <button
            onClick={() => {
              void navigator.clipboard.writeText(zidPubkey!);
              setZidCopied(true);
              setTimeout(() => setZidCopied(false), 1500);
            }}
            className='mx-4 mt-3 flex items-center gap-2 rounded-md border border-border-soft px-3 py-2 text-left hover:bg-elev-1 transition-colors'
          >
            <span className='i-lucide-fingerprint h-3.5 w-3.5 text-fg-dim' />
            <span className='text-xs tabular text-fg-muted truncate'>{zidAddress}</span>
            <span className='text-[10px] text-fg-dim ml-auto lowercase tracking-[0.04em]'>
              {zidCopied ? 'copied' : 'zid'}
            </span>
          </button>
        )}

        {/* menu items — grouped, with thin top border between groups */}
        <nav className='p-2'>
          {menuGroups.map((group, gi) => (
            <div
              key={gi}
              className={cn(gi > 0 && 'mt-1 pt-1 border-t border-border-soft/40')}
            >
              {group.map((item, i) => (
                <button
                  key={i}
                  onClick={item.onClick}
                  className={cn(
                    'flex w-full items-center gap-3 px-3 py-2.5 rounded-md text-[13px] text-fg hover:text-fg-high transition-colors hover:bg-elev-1',
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

        {/* footer — upgrade (if free) + donate (always offered when available) + about */}
        <div className='mt-auto border-t border-border-soft px-4 py-3 flex flex-col gap-2'>
          {!pro && (
            <button
              onClick={() => { navigate(PopupPath.SUBSCRIBE); onClose(); }}
              className='flex w-full items-center justify-center gap-2 px-3 py-2 rounded-md bg-zigner-gold text-zigner-dark hover:bg-zigner-gold-light transition-colors text-[13px] lowercase tracking-[0.04em]'
            >
              <span className='i-lucide-zap h-3.5 w-3.5' />
              <span>upgrade to pro</span>
            </button>
          )}
          {donation && (
            <button
              onClick={handleDonate}
              className='flex w-full items-center justify-center gap-2 px-3 py-2 rounded-md border border-border-soft text-[13px] text-fg-muted hover:text-fg-high hover:bg-elev-1 transition-colors'
            >
              <span className='i-lucide-heart h-3.5 w-3.5' />
              <span>donate {activeNetwork}</span>
            </button>
          )}

          <div className='mt-1 flex items-center gap-3 text-[10px] text-fg-dim lowercase tracking-[0.04em]'>
            <a href='https://rotko.net' target='_blank' rel='noopener noreferrer' className='hover:text-fg-high'>rotko.net</a>
            <a href='https://github.com/rotkonetworks/zafu' target='_blank' rel='noopener noreferrer' className='hover:text-fg-high'>github</a>
            <a href='https://zigner.rotko.net' target='_blank' rel='noopener noreferrer' className='hover:text-fg-high'>zigner</a>
          </div>
          <p className='text-[9px] text-fg-dim mt-1 tabular'>GPL-3.0</p>
        </div>
      </div>
    </>
  );
};
