import { ReactNode, memo, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { cn } from '@repo/ui/lib/utils';

export interface BottomTab {
  path: string;
  icon: ReactNode;
  activeIcon?: ReactNode;
  label: string;
}

interface BottomTabsProps {
  tabs: BottomTab[];
}

/** memoized tab button for minimal re-renders */
const TabButton = memo(({
  tab,
  isActive,
  onNavigate,
}: {
  tab: BottomTab;
  isActive: boolean;
  onNavigate: (path: string) => void;
}) => (
  <button
    onClick={() => onNavigate(tab.path)}
    className={cn(
      // GPU-accelerated transform instead of color changes
      'flex flex-1 flex-col items-center justify-center gap-0.5',
      'transform-gpu transition-transform duration-75',
      'active:scale-90', // instant feedback
      // CSS containment - isolate repaints
      'contain-layout contain-paint',
      isActive ? 'text-primary' : 'text-muted-foreground'
    )}
  >
    {isActive && tab.activeIcon ? tab.activeIcon : tab.icon}
    <span className='text-[10px]'>{tab.label}</span>
  </button>
));
TabButton.displayName = 'TabButton';

export const BottomTabs = memo(({ tabs }: BottomTabsProps) => {
  const location = useLocation();
  const navigate = useNavigate();

  const handleNavigate = useCallback((path: string) => {
    // don't navigate if already there
    if (location.pathname === path) return;
    navigate(path);
  }, [navigate, location.pathname]);

  return (
    <nav
      className={cn(
        'fixed bottom-0 left-0 right-0 z-50',
        'border-t border-border/40 bg-background',
        // GPU layer for smooth scrolling
        'transform-gpu will-change-transform',
        // CSS containment
        'contain-layout contain-style'
      )}
    >
      <div className='flex h-12 items-center justify-around'>
        {tabs.map(tab => {
          const isActive = location.pathname === tab.path ||
            (tab.path !== '/' && location.pathname.startsWith(tab.path));

          return (
            <TabButton
              key={tab.path}
              tab={tab}
              isActive={isActive}
              onNavigate={handleNavigate}
            />
          );
        })}
      </div>
    </nav>
  );
});
BottomTabs.displayName = 'BottomTabs';

export const BOTTOM_TABS_HEIGHT = '3rem';
