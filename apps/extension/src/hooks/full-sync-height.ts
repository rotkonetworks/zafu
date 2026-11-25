import { useLatestBlockHeight } from './latest-block-height';
import { useStore, type AllSlices } from '../state';
import { usePenumbraChainId } from '../penumbra/asset-registry';
import { PENUMBRA_MAINNET } from '../penumbra/chain';

/** the active penumbra wallet, picked the way the worker picks it */
const selectActiveWalletId = (s: AllSlices) =>
  (s.wallets.all[s.wallets.activeIndex] ?? s.wallets.all[0])?.id;

/**
 * the worker's published sync, only while it is the active wallet's on the
 * chain in use: never another wallet's height, nor mainnet's under a testnet
 */
export const usePenumbraSync = () => {
  const walletId = useStore(selectActiveWalletId);
  const chainId = usePenumbraChainId();
  const sync = useStore(s => s.network.penumbraSync);
  return sync && sync.walletId === walletId && (sync.chainId ?? PENUMBRA_MAINNET) === chainId
    ? sync
    : undefined;
};

export const useSyncProgress = () => {
  const sync = usePenumbraSync();
  const { data: queried, error } = useLatestBlockHeight(sync?.height);
  // a node that answered earlier than the sync has since read is behind it
  const tip = queried === undefined ? 0 : Math.max(queried, sync?.height ?? 0);
  return {
    tip,
    height: sync?.height,
    from: sync?.from ?? 0,
    error,
    /** sync stopped: local data could not be read or written */
    storageStopped: sync?.stopped === 'storage',
  };
};
