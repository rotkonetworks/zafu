import { useCallback } from 'react';
import { useStore } from '../state';
import { selectEffectiveKeyInfo, selectGetVaultUnlock } from '../state/keyring';
import { keyInfoSupportsNetwork } from '../state/keyring/vault-ops';
import { selectActiveZcashWallet } from '../state/wallets';
import { activeAccountIndex } from '../state/pockets';
import { spawnNetworkWorker, deriveAddressInWorker } from '../state/keyring/network-worker';
import type { AddressSource } from '../state/contact-share';

/**
 * Where the active wallet's own zcash addresses come from, for per-contact
 * addresses: a hot seed wallet stores no viewing key, so it derives in the
 * zcash worker; a watch-only or ledger wallet uses its stored ufvk.
 */
export const useContactAddressSource = (): (() => AddressSource) => {
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const getVaultUnlock = useStore(selectGetVaultUnlock);
  const zcashWallet = useStore(selectActiveZcashWallet);
  const pocket = useStore(activeAccountIndex);

  return useCallback(() => {
    if (keyInfo?.type === 'mnemonic' && keyInfoSupportsNetwork(keyInfo, 'zcash')) {
      return {
        seed: async index => {
          const vault = await getVaultUnlock(keyInfo.id);
          await spawnNetworkWorker('zcash');
          return deriveAddressInWorker('zcash', vault, index, undefined, pocket);
        },
      };
    }
    const ufvk = zcashWallet?.ufvk ?? zcashWallet?.orchardFvk;
    return { ufvk: typeof ufvk === 'string' ? ufvk : undefined };
  }, [keyInfo, getVaultUnlock, zcashWallet, pocket]);
};
