import { useLatestBlockHeight } from './latest-block-height';
import { useStore, type AllSlices } from '../state';

/** the active penumbra wallet, picked the way the worker picks it */
const selectActiveWalletId = (s: AllSlices) =>
  (s.wallets.all[s.wallets.activeIndex] ?? s.wallets.all[0])?.id;

/** the worker's published sync, only while it is the active wallet's: never another wallet's height */
export const usePenumbraSync = () => {
  const walletId = useStore(selectActiveWalletId);
  const sync = useStore(s => s.network.penumbraSync);
  return sync && sync.walletId === walletId ? sync : undefined;
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
  };
};
