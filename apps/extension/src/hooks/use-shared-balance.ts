/**
 * A shared wallet's balance (a group's, a deal's, any multisig seat): its
 * viewing key syncs in the zcash worker beside the active wallet while a
 * screen shows it, from the seat's birthday, and the balance is read as the
 * worker moves. Shared wallets are never part of the home total.
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
    const read = () =>
      void getBalanceInWorker('zcash', id).then(
        b => live && setBal({ id, zat: BigInt(b) }),
        () => undefined,
      );
    void (async () => {
      await spawnNetworkWorker('zcash');
      // a seat without a uview key reads what an earlier sync left
      if (ufvk && !isWalletSyncing('zcash', id)) {
        const from = await resolveBirthday(id, url, backend);
        await startWatchOnlySyncInWorker('zcash', id, ufvk, url, from, backend);
      }
      read();
    })().catch(() => undefined);
    const onSync = (e: Event) => (e as CustomEvent).detail?.network === 'zcash' && read();
    window.addEventListener('network-sync-progress', onSync);
    const t = setInterval(read, 15_000);
    return () => {
      live = false;
      clearInterval(t);
      window.removeEventListener('network-sync-progress', onSync);
    };
  }, [id, ufvk, url, backend]);
  return bal && bal.id === id ? bal.zat : undefined;
};
