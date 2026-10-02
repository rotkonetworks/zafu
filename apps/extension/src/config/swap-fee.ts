/**
 * zafu's own fee on swaps. Production lists NEAR_APP_FEE_BPS on near intents
 * routes and charges it less NEAR_APP_FEE_OFF_PCT, as a 1click app fee; thorchain carries none, since its own
 * dynamic minimum fee is how it competes. The beta build charges nothing on
 * any route.
 */

import { IS_BETA_BUILD } from './feature-flags';

export const NEAR_APP_FEE_BPS = 10;

/** the launch discount on that rate, shown as the list rate struck through */
export const NEAR_APP_FEE_OFF_PCT = 50;

/**
 * TODO(founder): the near account that receives the app fee. While empty the
 * fee is inert: no app fee is sent with a quote, and none is shown.
 */
export const NEAR_APP_FEE_RECIPIENT = '';

/**
 * A registered THORName for a future thorchain affiliate; unused while zafu
 * takes nothing there. If that changes, quote with `affiliate` and
 * `affiliate_bps` so the price shown matches the swap that runs.
 */
export const ZAFU_THORNAME = '';

/** what the production build really charges on near: nothing without a recipient */
export const zafuListBps = (recipient = NEAR_APP_FEE_RECIPIENT, bps = NEAR_APP_FEE_BPS): number =>
  recipient ? bps : 0;

/** zafu's fee on a route in this build */
export const zafuFeeBps = (
  route: string,
  beta = IS_BETA_BUILD,
  list = zafuListBps(),
  off = NEAR_APP_FEE_OFF_PCT,
): number => (beta || route !== 'near' ? 0 : Math.round((list * (100 - off)) / 100));
