import { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
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

export const BottomTabs = ({ tabs }: BottomTabsProps) => {
  const location = useLocation();

  return (
    <nav className='fixed bottom-0 left-0 right-0 z-50 border-t border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60'>
      <div className='flex h-14 items-center justify-around px-2'>
        {tabs.map(tab => {
          const isActive = location.pathname === tab.path ||
            (tab.path !== '/' && location.pathname.startsWith(tab.path));

          return (
            <NavLink
              key={tab.path}
              to={tab.path}
              className={cn(
                'flex flex-1 flex-col items-center justify-center gap-0.5 py-1 transition-colors',
                isActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <div className='flex h-6 w-6 items-center justify-center'>
                {isActive && tab.activeIcon ? tab.activeIcon : tab.icon}
              </div>
              <span className={cn(
                'text-[10px] font-medium',
                isActive && 'font-semibold'
              )}>
                {tab.label}
              </span>
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
};

export const BOTTOM_TABS_HEIGHT = '3.5rem';
