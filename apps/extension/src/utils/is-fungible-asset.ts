/**
 * fungible-asset filter
 *
 * Penumbra mints a synthetic per-position token for every LP position, auction,
 * delegation, unbonding, governance vote and proposal. They represent state,
 * not fungible balances a user can independently transfer, so they must NOT
 * appear in balance lists, asset pickers, or anywhere else a user is expected
 * to choose "an amount of X to move". They stay in state (the tx classifier
 * and the LP-history view still need them) - this helper only excludes them
 * from fungible-asset UI surfaces.
 *
 * Source of truth for the patterns is `@rotko/penumbra-types/assets`; keep
 * this list in sync with veil's `shouldFilterAsset` (see
 * apps/veil/src/pages/portfolio/api/use-unified-assets.ts in the penumbra-web
 * repo).
 *
 * Match against the DISPLAY denom, not the base denom. Delegation and
 * unbonding tokens carry the `udelegation_...` / `uunbonding_start_at_...`
 * SI prefix on `.base`, while their pattern regexes are anchored on
 * `^delegation_` / `^unbonding_start_at_`. Matching on `.display` (which
 * strips the SI prefix) gives correct results for every pattern.
 */

import { assetPatterns } from '@rotko/penumbra-types/assets';
import type { BalancesResponse } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import type { Metadata } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { getMetadataFromBalancesResponse } from '@penumbra-zone/getters/balances-response';

const NON_FUNGIBLE_PATTERNS = [
  assetPatterns.lpNft,
  assetPatterns.auctionNft,
  assetPatterns.unbondingToken,
  assetPatterns.votingReceipt,
  assetPatterns.proposalNft,
  assetPatterns.delegationToken,
] as const;

/**
 * True when the given display / symbol string names a non-fungible synthetic
 * Penumbra token (LP NFT, auction NFT, delegation token, etc.). Missing /
 * empty input is treated as fungible - "we don't know, don't hide it".
 */
export const isNonFungibleDisplay = (display: string | undefined): boolean => {
  if (!display) {
    return false;
  }
  return NON_FUNGIBLE_PATTERNS.some(pattern => pattern.matches(display));
};

/**
 * True when `metadata` describes a token users can meaningfully hold a
 * transferable balance of. Unknown / missing metadata is treated as fungible
 * so we never silently swallow a real balance we failed to classify.
 */
export const isFungibleMetadata = (metadata: Metadata | undefined): boolean =>
  !isNonFungibleDisplay(metadata?.display);

/**
 * True when `balance` should appear in a fungible-asset UI list.
 */
export const isFungibleBalance = (balance: BalancesResponse): boolean =>
  isFungibleMetadata(getMetadataFromBalancesResponse.optional(balance));

/**
 * Drop every synthetic per-position token from `balances`, preserving order.
 * Preferred entry point for balance lists / asset pickers so downstream
 * components don't each have to remember the pattern set.
 */
export const filterFungibleBalances = (balances: BalancesResponse[]): BalancesResponse[] =>
  balances.filter(isFungibleBalance);

/**
 * Stricter filter for ACTION SELECTORS (the swap from-leg, the send asset
 * picker) rather than balance lists: a balance is selectable only if it is
 * fungible AND carries resolved, human metadata (a symbol or display).
 *
 * Why the extra check: an LP-position NFT whose metadata has not resolved shows
 * up as "Unknown asset" with no display denom, so `isFungibleBalance` (which
 * matches the non-fungible patterns against the display string) can't see it and
 * lets it through - which is exactly the LP-NFT pollution reported in swap/send.
 * You cannot meaningfully choose an unnamed asset to move, so a selector should
 * hide it; a real-but-unresolved token is only transiently hidden until its
 * metadata loads. Balance LISTS deliberately keep using `filterFungibleBalances`
 * so a holding is never silently swallowed just because we failed to name it.
 */
export const isSelectableBalance = (balance: BalancesResponse): boolean => {
  const metadata = getMetadataFromBalancesResponse.optional(balance);
  if (!metadata) {
    return false;
  }
  const named =
    (metadata.symbol ?? '').trim().length > 0 || (metadata.display ?? '').trim().length > 0;
  if (!named) {
    return false;
  }
  return isFungibleMetadata(metadata);
};

/**
 * Drop non-fungible AND unnamed ("Unknown asset") balances - use for asset
 * pickers where the user chooses something to move. See {@link isSelectableBalance}.
 */
export const filterSelectableBalances = (balances: BalancesResponse[]): BalancesResponse[] =>
  balances.filter(isSelectableBalance);
