/**
 * headless dropdown primitive - solidjs-style composition
 * no styling opinions, just behavior
 */

import { useState, useCallback, useRef, useEffect, ReactNode } from 'react';

interface DropdownState {
  open: boolean;
  toggle: () => void;
  close: () => void;
}

/** hook for dropdown state - the primitive */
export const useDropdown = (): DropdownState => {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen(o => !o), []);
  const close = useCallback(() => setOpen(false), []);
  return { open, toggle, close };
};

interface DropdownProps {
  trigger: (state: DropdownState) => ReactNode;
  children: (state: DropdownState) => ReactNode;
  className?: string;
}

/** compound component - handles click-outside automatically */
export const Dropdown = ({ trigger, children, className }: DropdownProps) => {
  const state = useDropdown();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!state.open) return;

    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        state.close();
      }
    };

    // delay to avoid immediate close from trigger click
    const id = setTimeout(() => document.addEventListener('click', handleClick), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('click', handleClick);
    };
  }, [state.open, state.close]);

  return (
    <div ref={ref} className={className ?? 'relative'}>
      {trigger(state)}
      {state.open && children(state)}
    </div>
  );
};
