import { useEffect, useState } from 'react';
import { useStore } from '../state';
import { selectEffectiveKeyInfo } from '../state/keyring';
import { PEOPLE_ASKING_KEY, type PeopleAsking } from './protocol';

/**
 * How many people wait at the active wallet's open doors. Read from the
 * worker's session counts, so a tab badge never opens the vault.
 */
export const useAskingCount = (): number => {
  const walletId = useStore(s => selectEffectiveKeyInfo(s)?.id);
  const [asking, setAsking] = useState<PeopleAsking[]>([]);
  useEffect(() => {
    const read = () =>
      void chrome.storage.session
        .get(PEOPLE_ASKING_KEY)
        .then(v => setAsking((v[PEOPLE_ASKING_KEY] as PeopleAsking[] | undefined) ?? []))
        .catch(() => undefined);
    const changed = (changes: Record<string, unknown>, area: string) => {
      if (area === 'session' && PEOPLE_ASKING_KEY in changes) {
        read();
      }
    };
    read();
    chrome.storage.onChanged.addListener(changed);
    return () => chrome.storage.onChanged.removeListener(changed);
  }, []);
  const now = Date.now();
  return asking.filter(a => a.walletId === walletId && a.until > now).reduce((n, a) => n + a.n, 0);
};
