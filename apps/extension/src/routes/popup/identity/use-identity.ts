import { useEffect } from 'react';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo } from '../../../state/keyring';
import { useActiveZid } from '../../../hooks/use-active-zid';
import { ZID_PINS_STORAGE_KEY, getZidPins, type ZidPin } from '../../../state/identity';

/** what an identity is called: its pin's name, "personal" for the first, else its number.
 *  An unnamed pin, or an older build's "gen <n>" placeholder, is no name at all. */
export const identityLabel = (index: number, pins: readonly ZidPin[]): string => {
  const label = pins.find(p => p.index === index)?.label.trim();
  return label && !/^gen \d+$/.test(label) ? label : index === 0 ? 'personal' : `identity ${index}`;
};

/**
 * The active wallet's identity right now: its generation, that generation's
 * key, the named (pinned) generations, and the current one's name. Pins live
 * per wallet under `zidPins:<walletId>`; the listener keeps every screen that
 * shows the name in step when another one renames or switches.
 */
export const zidPinsQuery = (walletId: string) =>
  queryOptions({
    queryKey: ['zidPins', walletId],
    queryFn: () => getZidPins(walletId).catch((): ZidPin[] => []),
  });

const NO_PINS: ZidPin[] = [];

export const useIdentity = () => {
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const walletId = keyInfo?.id ?? '';
  const { zidIndex, zidPubkey } = useActiveZid(keyInfo);
  const client = useQueryClient();
  const pins = useQuery(zidPinsQuery(walletId)).data ?? NO_PINS;

  useEffect(() => {
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) =>
      area === 'local' &&
      Object.keys(changes).some(k => k.startsWith(ZID_PINS_STORAGE_KEY)) &&
      void client.invalidateQueries({ queryKey: ['zidPins'] });
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [client]);

  return { keyInfo, walletId, zidIndex, zidPubkey, pins, label: identityLabel(zidIndex, pins) };
};
