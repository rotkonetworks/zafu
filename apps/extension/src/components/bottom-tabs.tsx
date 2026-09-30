import { memo, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { cn } from '@repo/ui/lib/utils';
import { screenTransition } from '../utils/navigate';
import { PopupPath } from '../routes/popup/paths';

/**
 * Four fixed tabs, the same on every network: wallet, people, tools,
 * settings. Nothing here is feature-gated per network any more - a network
 * without vote/stake/swap simply shows fewer tiles on the tools screen.
 */
const TABS = [
  { path: PopupPath.INDEX, icon: 'i-zafu-mon', label: 'wallet' },
  { path: PopupPath.INBOX, icon: 'i-zafu-letter', label: 'people' },
  { path: PopupPath.TOOLS, icon: 'i-ph-wrench', label: 'tools' },
  { path: PopupPath.SETTINGS, icon: 'i-ph-gear-six', label: 'settings' },
] as const;

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
      onClick={() => onNavigate(tab.path)}
      className={cn(
        'flex flex-1 flex-col items-center justify-center gap-0.5',
        'transition-colors hover:text-fg-high',
        isActive ? 'text-zigner-gold' : 'text-fg-dim',
      )}
    >
      <span className={cn(tab.icon, 'size-5')} aria-hidden='true' />
      <span className='text-label lowercase'>{tab.label}</span>
    </button>
  ),
);
TabButton.displayName = 'TabButton';

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
      <div className='flex h-12 items-center justify-around'>
        {TABS.map(tab => {
          const isActive =
            location.pathname === tab.path ||
            (tab.path !== PopupPath.INDEX && location.pathname.startsWith(tab.path));
          return (
            <TabButton key={tab.path} tab={tab} isActive={isActive} onNavigate={handleNavigate} />
          );
        })}
      </div>
    </nav>
  );
});
BottomTabs.displayName = 'BottomTabs';

export const BOTTOM_TABS_HEIGHT = '3rem';
