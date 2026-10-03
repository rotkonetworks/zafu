/**
 * Fiat ramps: outside services, not part of zafu.
 *
 * Peer referral: L59SD4 is a SELLER (maker) referral. It earns when a referred
 * person sells, never on a buy, and only Peer's /referrals page reads it. The
 * cash-out flow attaches it; the buy link below cannot carry it.
 */
export const PEER_REFERRAL_CODE = 'L59SD4';

/** canonical USDC on Base, the token every Peer buy delivers */
export const BASE_CHAIN_ID = 8453;
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/**
 * Peer's own buy screen, prefilled. Only the redirect params Peer's app reads
 * (app.peer.xyz bundle, `FT`): referrer, inputCurrency, inputAmount,
 * paymentPlatform, toToken, recipientAddress. `referrer` is a display name;
 * this link earns zafu nothing, it is the "or on peer's site" fallback.
 */
export const peerBuyUrl = (o: {
  currency?: string;
  amount?: string;
  platform?: string;
  recipient?: string;
}): string => {
  const p = new URLSearchParams({ referrer: 'zafu' });
  if (o.currency) {
    p.set('inputCurrency', o.currency.toUpperCase());
  }
  if (o.amount && /^\d*(\.\d{0,6})?$/.test(o.amount)) {
    p.set('inputAmount', o.amount);
  }
  if (o.platform) {
    p.set('paymentPlatform', o.platform);
  }
  p.set('toToken', `${BASE_CHAIN_ID}:${BASE_USDC}`);
  if (o.recipient) {
    p.set('recipientAddress', o.recipient);
  }
  return `https://app.peer.xyz/swap?${p.toString()}`;
};
