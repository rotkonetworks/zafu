import { useEffect, useRef } from 'react';
import { useStore } from '../state';
import { usePeople } from '../people/client';
import type { Thread } from '../people/vault';
import { newIncoming, play } from './chime';

/** the bell: mounted only while it is on, so a quiet zafu never reads the threads for it */
const MessageBell = () => {
  const { threads, loaded } = usePeople();
  const seen = useRef<Record<string, Thread> | undefined>(undefined);
  useEffect(() => {
    if (!loaded) {
      return;
    }
    // the first read is what was already there, not news
    if (seen.current && newIncoming(seen.current, threads)) {
      play('message');
    }
    seen.current = threads;
  }, [threads, loaded]);
  return null;
};

/** the taps: the zcash scan's count of payments from someone else, going up */
const MoneyTaps = () => {
  useEffect(() => {
    const counts = new Map<string, number>();
    const onProgress = (e: Event) => {
      const d = (e as CustomEvent<{ network?: string; walletId?: string; received?: number }>)
        .detail;
      if (d?.network !== 'zcash' || typeof d.received !== 'number' || !d.walletId) {
        return;
      }
      const before = counts.get(d.walletId);
      counts.set(d.walletId, d.received);
      if (before !== undefined && d.received > before) {
        play('money');
      }
    };
    window.addEventListener('network-sync-progress', onProgress);
    return () => window.removeEventListener('network-sync-progress', onProgress);
  }, []);
  return null;
};

export const Chimes = () => {
  const messages = useStore(s => s.privacy.settings.soundMessages);
  const money = useStore(s => s.privacy.settings.soundMoney);
  return (
    <>
      {messages && <MessageBell />}
      {money && <MoneyTaps />}
    </>
  );
};
