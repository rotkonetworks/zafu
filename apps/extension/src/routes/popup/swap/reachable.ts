/**
 * Whether an asset on Penumbra can still leave the way it came. An IBC asset's
 * base denom names its channel (transfer/channel-4/uosmo); once that channel's
 * client expires the asset trades on the dex but can't be withdrawn. Native
 * assets (um, delegation tokens) have no channel and are always reachable.
 */

import type { PenumbraRoute } from '@repo/wallet/networks/cosmos/penumbra-routes';

/** 'channel-4' for transfer/channel-4/uosmo, undefined for a native asset */
export const channelOf = (base: string | undefined): string | undefined =>
  /^transfer\/(channel-\d+)\//.exec(base ?? '')?.[1];

export interface Reach {
  reachable: boolean;
  /** "osmosis-1" for a live channel, "channel 4" for a closed one */
  via?: string;
}

/** routes undefined = discovery never ran: hide nothing on missing data */
export const reachOf = (base: string | undefined, routes: PenumbraRoute[] | undefined): Reach => {
  const channel = channelOf(base);
  if (!channel) {
    return { reachable: true };
  }
  const route = routes?.find(r => r.penumbraSourceChannel === channel);
  if (!routes || route?.active) {
    return { reachable: true, via: route?.chainId };
  }
  return { reachable: false, via: channel.replace('-', ' ') };
};

/**
 * The "you get" list: reachable assets and the ones you hold, then (only when
 * asked) the rest. An asset you hold is never hidden.
 */
export const splitByReach = <T>(
  assets: readonly T[],
  base: (a: T) => string | undefined,
  held: (a: T) => boolean,
  routes: PenumbraRoute[] | undefined,
): { shown: T[]; hidden: T[] } => {
  const shown: T[] = [];
  const hidden: T[] = [];
  for (const a of assets) {
    (reachOf(base(a), routes).reachable || held(a) ? shown : hidden).push(a);
  }
  return { shown, hidden };
};
