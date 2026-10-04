import { useSyncExternalStore } from 'react';

const subscribe = (onChange: () => void) => {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
};

/** whether this computer has a network at all; zafu asks nothing to find out */
export const useOnline = () => useSyncExternalStore(subscribe, () => navigator.onLine);
