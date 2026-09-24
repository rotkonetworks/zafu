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

/** True when any non-fungible pattern matches the given denom string. */
const matchesNonFungible = (value: string | undefined): boolean => {
  if (!value) {
    return false;
  }
  return NON_FUNGIBLE_PATTERNS.some(pattern => pattern.matches(value));
};

/**
 * True when the given display / symbol string names a non-fungible synthetic
 * Penumbra token (LP NFT, auction NFT, delegation token, etc.). Missing /
 * empty input is treated as fungible - "we don't know, don't hide it".
 */
export const isNonFungibleDisplay = (display: string | undefined): boolean =>
  matchesNonFungible(display);

/**
 * True when `metadata` describes a token users can meaningfully hold a
 * transferable balance of. Unknown / missing metadata is treated as fungible
 * so we never silently swallow a real balance we failed to classify.
 *
 * The patterns must be tested against BOTH the base and the display denom, not
 * display alone: the pattern anchors differ per token. `lpNft`/`auctionNft` are
 * anchored on the BASE form (`^lpnft_`, `^auctionnft_`), while the LP NFT's
 * DISPLAY denom is `lpNft:opened(...)` - which `^lpnft_` never matches (capital
 * N, a colon, no underscore). Matching display only therefore let every LP
 * position leak into the swap/send pickers (reported: "100 lpNft:opened(...) in
 * the send asset dropdown"). Delegation/unbonding conversely need the display
 * form (their base carries a `u` SI prefix), so we check both and hide the
 * balance if EITHER matches.
 */
export const isFungibleMetadata = (metadata: Metadata | undefined): boolean =>
  !matchesNonFungible(metadata?.display) && !matchesNonFungible(metadata?.base);

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

// ── picker selectors (react-query `select`) ──
//
// Every consumer of the `['balances', account]` query shares ONE cache entry
// holding the RAW `BalancesResponse[]` (see `hooks/penumbra-balances.ts`). The
// per-consumer filtering and sorting lives here, applied through react-query's
// per-observer `select` option, so it runs on the cached data no matter which
// consumer (home preload, assets table, send, swap) populated the cache.
// Filtering inside `queryFn` never took effect: the home screen preloads the
// key with the raw list, and react-query serves that cache instead of calling
// the picker's queryFn - which is how LP NFTs kept flooding the pickers.
//
// These must never mutate their input: the cached array is shared by every
// observer. `filter` copies before `sort` sorts.

/** priorityScore desc - the order every picker has always used. */
const byPriorityDesc = (a: BalancesResponse, b: BalancesResponse): number => {
  const aScore = getMetadataFromBalancesResponse.optional(a)?.priorityScore ?? 0n;
  const bScore = getMetadataFromBalancesResponse.optional(b)?.priorityScore ?? 0n;
  return Number(bScore - aScore);
};

/** Tokens surfaced in a picker's "positions" tab: LP-position and auction NFTs. */
const POSITION_PATTERNS = [assetPatterns.lpNft, assetPatterns.auctionNft] as const;

const matchesPosition = (value: string | undefined): boolean =>
  !!value && POSITION_PATTERNS.some(pattern => pattern.matches(value));

/**
 * True when `metadata` is an LP-position or auction NFT. Matched on base OR
 * display, same reasoning as {@link isFungibleMetadata}: the patterns anchor on
 * the base form (`lpnft_...`), while the LP display is `lpNft:opened(...)`.
 * Governance receipts, proposal NFTs and delegation / unbonding tokens are
 * deliberately NOT positions.
 */
export const isPositionMetadata = (metadata: Metadata | undefined): boolean =>
  matchesPosition(metadata?.base) || matchesPosition(metadata?.display);

export const isPositionBalance = (balance: BalancesResponse): boolean =>
  isPositionMetadata(getMetadataFromBalancesResponse.optional(balance));

/** Send / swap picker "assets" tab: selectable (fungible AND named), priority-sorted. */
export const selectPickerBalances = (raw: BalancesResponse[]): BalancesResponse[] =>
  filterSelectableBalances(raw).sort(byPriorityDesc);

/** Send / swap picker "positions" tab: LP-position + auction NFTs, priority-sorted. */
export const selectPositionBalances = (raw: BalancesResponse[]): BalancesResponse[] =>
  raw.filter(isPositionBalance).sort(byPriorityDesc);

export interface PickerBuckets {
  assets: BalancesResponse[];
  positions: BalancesResponse[];
}

/** Both picker tabs from one raw list. Anything in neither bucket stays hidden. */
export const selectPickerBuckets = (raw: BalancesResponse[]): PickerBuckets => ({
  assets: selectPickerBalances(raw),
  positions: selectPositionBalances(raw),
});

/**
 * IBC-withdraw asset list: selectable balances that also carry a base denom
 * (no base = not withdrawable). Original order, no sort.
 */
export const selectWithdrawableBalances = (raw: BalancesResponse[]): BalancesResponse[] =>
  filterSelectableBalances(raw).filter(b => !!getMetadataFromBalancesResponse.optional(b)?.base);

const positionState = (base: string): string => {
  if (assetPatterns.lpNftOpened.matches(base)) {
    return 'opened';
  }
  if (assetPatterns.lpNftClosed.matches(base)) {
    return 'closed';
  }
  if (assetPatterns.lpNftWithdrawn.matches(base)) {
    return 'withdrawn';
  }
  if (assetPatterns.auctionNft.matches(base)) {
    return 'auction';
  }
  return 'position';
};

/**
 * Short label for a position NFT row. LP / auction NFT symbols embed the full
 * bech32 position id, so rows would be unreadably long (or, once truncated,
 * identical). Returns e.g. `opened plpid1abcd...wxyz`; undefined for anything
 * that is not a position.
 */
export const positionLabel = (metadata: Metadata | undefined): string | undefined => {
  if (!metadata || !isPositionMetadata(metadata)) {
    return undefined;
  }
  const state = positionState(metadata.base);
  const id = /(plpid1[a-z0-9]+|pauctid1[a-z0-9]+)/i.exec(
    `${metadata.base} ${metadata.display}`,
  )?.[1];
  if (!id) {
    return state;
  }
  const short = id.length > 18 ? `${id.slice(0, 10)}...${id.slice(-4)}` : id;
  return `${state} ${short}`;
};
