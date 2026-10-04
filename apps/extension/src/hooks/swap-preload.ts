/**
 * Whose swap it is. The swap route's intent preload (routes/popup/route-preloads.ts)
 * asks state/swap/preload for the price the screen will open on, for this wallet.
 */

import type { AllSlices } from '../state';
import { selectEffectiveKeyInfo } from '../state/keyring';
import { activeZcashStoreId } from '../state/pockets';

/** the wallet a swap's defaults and prices belong to: the active pocket's store */
export const swapWallet = (s: AllSlices): string | undefined =>
  activeZcashStoreId(s) ?? selectEffectiveKeyInfo(s)?.id;
