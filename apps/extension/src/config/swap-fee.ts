/**
 * zafu's own fee on swaps. Production lists NEAR_APP_FEE_BPS on near intents
 * routes and charges it less NEAR_APP_FEE_OFF_PCT, as a 1click app fee; thorchain carries none, since its own
 * dynamic minimum fee is how it competes. Every build charges the same; the
 * discount is the beta price, so the rate can rise later.
 */

export const NEAR_APP_FEE_BPS = 10;

/** the launch discount on that rate, shown as the list rate struck through */
export const NEAR_APP_FEE_OFF_PCT = 0;

/**
 * The near account that receives the app fee (the same account the 1click
 * integration has paid since 25.3.0). Empty = the fee is inert.
 */
export const NEAR_APP_FEE_RECIPIENT =
  'bdb384d8c6273bf4e40757d57d49ff7931c12b4ddaa838c323e4f93a7263744f';

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
  list = zafuListBps(),
  off = NEAR_APP_FEE_OFF_PCT,
): number => (route !== 'near' ? 0 : Math.round((list * (100 - off)) / 100));
