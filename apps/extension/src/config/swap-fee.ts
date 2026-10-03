/**
 * zafu's own fee on swaps: one rate on every route, the single source the
 * swap and buy flows both import. ZAFU_LIST_FEE_BPS is the normal rate, shown
 * struck through; ZAFU_FEE_BPS is what this build charges (the beta price,
 * so the rate can rise later). On near intents it is a 1click app fee; on
 * thorchain it is an affiliate fee paid to the THORName `zafu` (in rune).
 * Maya carries none.
 */

/** the normal rate, shown struck through beside the beta price */
export const ZAFU_LIST_FEE_BPS = 50;

/** beta: zafu charges nothing on any route or buy. The one flag to flip when the beta ends */
export const ZAFU_BETA_FREE = true;

/** the rate zafu charges once the beta ends */
export const ZAFU_PAID_FEE_BPS = 20;

/** what zafu charges on every route in this build */
export const ZAFU_FEE_BPS = ZAFU_BETA_FREE ? 0 : ZAFU_PAID_FEE_BPS;

/** the beta discount, derived from the two rates above (100 while free, 60 at 0.2%) */
export const ZAFU_FEE_OFF_PCT = Math.round(100 - (ZAFU_FEE_BPS * 100) / ZAFU_LIST_FEE_BPS);

export const NEAR_APP_FEE_BPS = ZAFU_FEE_BPS;

/**
 * The near account that receives the app fee (the same account the 1click
 * integration has paid since 25.3.0). Empty = the fee is inert.
 */
export const NEAR_APP_FEE_RECIPIENT =
  'bdb384d8c6273bf4e40757d57d49ff7931c12b4ddaa838c323e4f93a7263744f';

/** zafu's THORName (owner thor1qnulc66wrfycz6takz9xqdvdmpk9kgd5rzy80k, paid in rune) */
export const THOR_AFFILIATE = 'zafu';
export const THOR_AFFILIATE_BPS = ZAFU_FEE_BPS;

/** who receives zafu's fee on each route; a route without one charges nothing */
const FEE_TO: Record<string, string> = { near: NEAR_APP_FEE_RECIPIENT, thor: THOR_AFFILIATE };

/** the normal rate where a fee can be paid: nothing without a recipient */
export const zafuListBps = (recipient = NEAR_APP_FEE_RECIPIENT): number =>
  recipient ? ZAFU_LIST_FEE_BPS : 0;

/** zafu's fee on a route in this build */
export const zafuFeeBps = (route: string, list = zafuListBps(FEE_TO[route] ?? '')): number =>
  Math.round((list * ZAFU_FEE_BPS) / ZAFU_LIST_FEE_BPS);
