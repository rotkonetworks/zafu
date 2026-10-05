/**
 * A shared wallet's balance (a group's, a deal's, any multisig seat): its
 * viewing key syncs in the zcash worker beside the active wallet while a
 * screen shows it, from the seat's birthday, and the balance is read as the
 * worker moves, at most once per {@link READ_MS}. A read that finds the same
 * balance changes nothing, so a row does not draw again for it. Shared
 * wallets are never part of the home total.
 */

import { useEffect, useState } from 'react';
import { useStore } from '../state';
import {
  getBalanceInWorker,
  isWalletSyncing,
  spawnNetworkWorker,
  startWatchOnlySyncInWorker,
} from '../state/keyring/network-worker';
import type { ZcashWalletJson } from '../state/wallets';
import { resolveBirthday } from './zcash-auto-sync';

/** the least time between two balance reads of one shared wallet */
const READ_MS = 15_000;

export const useSharedBalance = (w: ZcashWalletJson | undefined): bigint | undefined => {
  const url = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const backend = useStore(s => s.networks.networks.zcash.backend) ?? 'zidecar';
  const [bal, setBal] = useState<{ id: string; zat: bigint }>();
  const id = w?.vaultId;
  const ufvk = w?.orchardFvk?.startsWith('uview') ? w.orchardFvk : undefined;
  useEffect(() => {
    if (!id) {
      return;
    }
    let live = true;
    let readAt = 0;
    const read = () => {
      readAt = Date.now();
      void getBalanceInWorker('zcash', id).then(
        b => {
          const zat = BigInt(b);
          if (live) {
            setBal(cur => (cur?.id === id && cur.zat === zat ? cur : { id, zat }));
          }
        },
        () => undefined,
      );
    };
    void (async () => {
      await spawnNetworkWorker('zcash');
      // a seat without a uview key reads what an earlier sync left
      if (ufvk && !isWalletSyncing('zcash', id)) {
        const from = await resolveBirthday(id, url, backend);
        await startWatchOnlySyncInWorker('zcash', id, ufvk, url, from, backend);
      }
      read();
    })().catch(() => undefined);
    // progress comes many times a second during a catch-up: read on it only when due
    const onSync = (e: Event) =>
      (e as CustomEvent).detail?.network === 'zcash' && Date.now() - readAt >= READ_MS && read();
    window.addEventListener('network-sync-progress', onSync);
    const t = setInterval(read, READ_MS);
    return () => {
      live = false;
      clearInterval(t);
      window.removeEventListener('network-sync-progress', onSync);
    };
  }, [id, ufvk, url, backend]);
  return bal && bal.id === id ? bal.zat : undefined;
};
