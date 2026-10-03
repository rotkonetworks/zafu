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

/** Peer's curator (quotes, intent signing) and its payment verifier */
export const PEER_API = 'https://api.zkp2p.xyz';
export const PEER_ATTESTATION = 'https://attestation-service.zkp2p.xyz';
export const PEER_HOSTS = [PEER_API, PEER_ATTESTATION];

/** Base's public rpc: reads, and the person's own transactions */
export const BASE_RPC = 'https://mainnet.base.org';

/** zafu's gas sponsor: a few cents of eth so a fresh base address can signal */
export const BASE_GAS_SPONSOR = 'https://sponsor.zafu.pro/base/gas';

/**
 * zafu's fee on a buy, paid by the buyer through signalIntent `referralFees`
 * (Peer's curator adds it to the quote). One fee per buy: the swap leg after
 * it carries no zafu fee. List rate struck through, then what beta charges.
 */
export {
  ZAFU_LIST_FEE_BPS as ZAFU_BUY_FEE_BPS_LIST,
  ZAFU_FEE_BPS as ZAFU_BUY_FEE_BPS,
} from './swap-fee';

/**
 * The zafu-owned Base address that receives the buy fee. The founder provides
 * it; until then it is null and a buy signals with no zafu fee entry and shows
 * no zafu line. Never invent one.
 */
export const ZAFU_BUY_FEE_RECIPIENT: `0x${string}` | null = null;
