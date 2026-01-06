'use client';

import * as React from 'react';
import { cn } from '../../../lib/utils';

export interface ThemeToggleProps {
  className?: string;
}

const ThemeToggle: React.FC<ThemeToggleProps> = ({ className }) => {
  const [isDark, setIsDark] = React.useState(() => {
    if (typeof window !== 'undefined') {
      return document.documentElement.classList.contains('dark');
    }
    return false;
  });

  const toggleTheme = React.useCallback(() => {
    const newIsDark = !isDark;
    setIsDark(newIsDark);

    if (newIsDark) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  }, [isDark]);

  // Initialize theme from localStorage on mount
  React.useEffect(() => {
    const savedTheme = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

    if (savedTheme === 'dark' || (!savedTheme && prefersDark)) {
      document.documentElement.classList.add('dark');
      setIsDark(true);
    } else {
      document.documentElement.classList.remove('dark');
      setIsDark(false);
    }
  }, []);

  return (
    <button
      onClick={toggleTheme}
      className={cn(
        'inline-flex items-center justify-center h-8 px-3 text-xs font-bold uppercase',
        'border-2 transition-[background-color,color] duration-75',
        isDark
          ? 'border-[#f4a31e] bg-[#12121a] text-[#f4a31e] hover:bg-[#f4a31e] hover:text-black'
          : 'border-[#000066] bg-white text-[#000066] hover:bg-[#000066] hover:text-white',
        className
      )}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {isDark ? 'Light' : 'Dark'}
    </button>
  );
};

ThemeToggle.displayName = 'ThemeToggle';

export { ThemeToggle };
