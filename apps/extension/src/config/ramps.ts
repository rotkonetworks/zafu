/**
 * Fiat ramps: outside services, not part of zafu. The wallet never holds or
 * routes these trades; it only opens the service in a tab.
 *
 * Peer referral: a six-char code the buyer redeems in their Peer account;
 * Peer's own referral page applies it, so every "buy on peer" link goes there
 * first. Change the code here only (zafu.pro's src/content/ramps.ts keeps the
 * same one).
 */
export const PEER_REFERRAL_CODE = 'L59SD4';
export const PEER_REFERRAL_URL = `https://app.peer.xyz/referrals?referralCode=${PEER_REFERRAL_CODE}`;
