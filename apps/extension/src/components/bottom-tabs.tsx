import { memo, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { cn } from '@repo/ui/lib/utils';
import { screenTransition } from '../utils/navigate';
import { PopupPath } from '../routes/popup/paths';
import { useStore, type AllSlices } from '../state';

/** something someone sent you that you have not opened yet */
const selectUnread = (s: AllSlices): boolean =>
  Array.isArray(s.messages.messages) &&
  s.messages.messages.some(m => m.direction === 'received' && !m.read);

/**
 * Four fixed tabs, the same on every network: wallet, people, tools,
 * settings. Nothing here is feature-gated per network any more - a network
 * without vote/stake/swap simply shows fewer tiles on the tools screen.
 */
const TABS = [
  { path: PopupPath.INDEX, icon: 'i-zafu-mon', label: 'wallet' },
  { path: PopupPath.INBOX, icon: 'i-zafu-letter', label: 'people' },
  { path: PopupPath.TOOLS, icon: 'i-zafu-torii', label: 'tools' },
  { path: PopupPath.SETTINGS, icon: 'i-zafu-shoji', label: 'settings' },
] as const;

const UnreadDot = () =>
  useStore(selectUnread) ? (
    <span className='absolute left-[58%] top-2 size-[7px] bg-hanko' aria-label='unread' />
  ) : null;

const TabButton = memo(
  ({
    tab,
    isActive,
    onNavigate,
  }: {
    tab: (typeof TABS)[number];
    isActive: boolean;
    onNavigate: (path: string) => void;
  }) => (
    <button
      data-preload={tab.path}
      onClick={() => onNavigate(tab.path)}
      className={cn(
        'relative flex flex-1 flex-col items-center justify-center gap-[5px]',
        'transition-colors hover:text-fg-high',
        isActive ? 'text-zigner-gold' : 'text-fg-muted',
      )}
    >
      <span className={cn(tab.icon, 'size-5')} aria-hidden='true' />
      <span className='text-[11px] leading-none lowercase'>{tab.label}</span>
      {tab.path === PopupPath.INBOX && <UnreadDot />}
    </button>
  ),
);
TabButton.displayName = 'TabButton';

/** screens opened from a tab keep that tab lit */
const OWNER: [string, string][] = [
  [PopupPath.SETTINGS, PopupPath.SETTINGS],
  [PopupPath.INBOX, PopupPath.INBOX],
  [PopupPath.CONTACTS, PopupPath.INBOX],
  // passkeys and passwords sits under "you" (IdKeys.dc.html), so people
  [PopupPath.IDENTITY, PopupPath.INBOX],
  [PopupPath.MULTISIG, PopupPath.INBOX],
  [PopupPath.TOOLS, PopupPath.TOOLS],
  [PopupPath.SWAP, PopupPath.TOOLS],
  [PopupPath.STAKE, PopupPath.TOOLS],
  [PopupPath.VOTE, PopupPath.TOOLS],
  [PopupPath.NOTE_SYNC, PopupPath.TOOLS],
];
const tabOf = (pathname: string): string =>
  OWNER.find(([prefix]) => pathname === prefix || pathname.startsWith(prefix + '/'))?.[1] ??
  PopupPath.INDEX;

export const BottomTabs = memo(() => {
  const location = useLocation();
  const navigate = useNavigate();

  const handleNavigate = useCallback(
    (path: string) => {
      if (location.pathname === path) {
        return;
      }
      navigate(path, screenTransition('tab'));
    },
    [navigate, location.pathname],
  );

  return (
    <nav
      className={cn(
        'fixed bottom-0 left-0 right-0 z-50',
        'border-t border-border-soft bg-canvas',
        'transform-gpu will-change-transform',
        'contain-layout contain-style',
      )}
    >
      <div className='flex h-14 items-stretch'>
        {TABS.map(tab => {
          const isActive = tabOf(location.pathname) === tab.path;
          return (
            <TabButton key={tab.path} tab={tab} isActive={isActive} onNavigate={handleNavigate} />
          );
        })}
      </div>
    </nav>
  );
});
BottomTabs.displayName = 'BottomTabs';

export const BOTTOM_TABS_HEIGHT = '3.5rem';
