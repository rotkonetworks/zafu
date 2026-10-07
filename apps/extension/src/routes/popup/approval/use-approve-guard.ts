import { useEffect, useState } from 'react';

/**
 * Whether approve may be pressed: not until the screen has been visible for
 * `seconds`, so a click meant for the page underneath cannot land on it.
 * Focus does not count: a side panel is visible without ever holding focus.
 * Only hidden -> visible (the screen was covered and shown again, the
 * clickjacking case) starts the wait over.
 */
export const useApproveGuard = (seconds: number): boolean => {
  const [ready, setReady] = useState(seconds <= 0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      setReady(seconds <= 0);
      if (seconds > 0 && document.visibilityState === 'visible') {
        timer = setTimeout(() => setReady(true), seconds * 1000);
      }
    };
    arm();
    document.addEventListener('visibilitychange', arm);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', arm);
    };
  }, [seconds]);

  return ready;
};
