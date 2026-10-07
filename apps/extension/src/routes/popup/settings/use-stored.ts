import { useEffect, useState } from 'react';
import { localExtStorage, type LocalStorageState } from '@repo/storage-chrome/local';
import { readEgressView } from '../../../net/egress-opt-in';

/**
 * One plain storage key, read once and followed while mounted - for the
 * settings the service worker reads straight from storage (relays, discovery)
 * rather than through the store. `undefined` until the first read lands.
 */
export const useStored = <K extends keyof LocalStorageState>(key: K) => {
  const [value, setValue] = useState<{ v: LocalStorageState[K] | undefined }>();
  useEffect(() => {
    let live = true;
    const load = () =>
      void localExtStorage.get(key).then(v => live && setValue({ v: v ?? undefined }));
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && key in changes) {
        load();
      }
    };
    load();
    globalThis.chrome?.storage?.onChanged?.addListener(onChanged);
    return () => {
      live = false;
      globalThis.chrome?.storage?.onChanged?.removeListener(onChanged);
    };
  }, [key]);
  return value;
};

/** how many destinations zafu may contact now; undefined until the policy view is read */
export const useDestinationsOn = () => {
  const [on, setOn] = useState<number>();
  useEffect(() => {
    void readEgressView().then(v => setOn(v.filter(d => d.on && d.hosts.length).length));
  }, []);
  return on;
};
