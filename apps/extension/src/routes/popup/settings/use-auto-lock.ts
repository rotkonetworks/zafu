import { useCallback, useEffect, useState } from 'react';
import { localExtStorage } from '@repo/storage-chrome/local';

/**
 * Auto-lock timeout, in minutes, persisted under the localExtStorage key
 * 'autoLockMinutes'. The service worker is the consumer of this value (see
 * service-worker.ts, which reads `autoLockMinutes` with a 15 default to set
 * the idle-lock alarm), so writing it here is all the wiring the feature
 * needs - there is no separate SW side to build.
 *
 * 0 means auto-lock disabled.
 */
export const AUTO_LOCK_OPTIONS = [
  { label: 'off', value: 0 },
  { label: '1 min', value: 1 },
  { label: '5 min', value: 5 },
  { label: '15 min', value: 15 },
  { label: '30 min', value: 30 },
] as const;

export const AUTO_LOCK_DEFAULT = 15;

export const useAutoLock = () => {
  const [minutes, setMinutes] = useState<number>(AUTO_LOCK_DEFAULT);

  useEffect(() => {
    let live = true;
    void localExtStorage.get('autoLockMinutes').then(v => {
      if (live) {
        setMinutes(v ?? AUTO_LOCK_DEFAULT);
      }
    });
    return () => {
      live = false;
    };
  }, []);

  const set = useCallback((value: number) => {
    setMinutes(value);
    void localExtStorage.set('autoLockMinutes', value);
  }, []);

  return { minutes, set };
};
