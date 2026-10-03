/**
 * The swap entry points' preload (state/swap/preload): a press asks for the
 * price the swap screen will open on. Nothing here runs as a screen loads.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useStore, type AllSlices } from '../state';
import { selectActiveNetwork, selectEffectiveKeyInfo } from '../state/keyring';
import { activeZcashStoreId } from '../state/pockets';
import { preloadSwapQuote } from '../state/swap/preload';

/** the wallet a swap's defaults and prices belong to: the active pocket's store */
export const swapWallet = (s: AllSlices): string | undefined =>
  activeZcashStoreId(s) ?? selectEffectiveKeyInfo(s)?.id;

/** pointerdown/focus props for a swap entry point */
export const useSwapPreload = () => {
  const client = useQueryClient();
  const wallet = useStore(s => (selectActiveNetwork(s) === 'zcash' ? swapWallet(s) : undefined));
  const warm = () => {
    if (wallet) {
      void preloadSwapQuote({ client, wallet }).catch(() => undefined);
    }
  };
  return { onPointerDown: warm, onFocus: warm };
};
