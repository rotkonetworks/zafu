/**
 * The penumbra-1 asset registry zafu currently trusts for display: the stored
 * signed live copy when one verifies (transparent/registry-live), else the
 * bundled copy. Read-only, never touches the network.
 *
 * This is the one place every symbol/name/image path reads from, so a
 * registry rename (e.g. `axlUSDT` -> `USDT.axl`) shows on the Penumbra home
 * row, the token sheet, the send/swap pickers and history all at once,
 * instead of each screen carrying its own stale copy of the view service's
 * metadata.
 */

import { ChainRegistryClient, Registry } from '@penumbrafi/registry';
import type { Metadata } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { storedRegistryJson } from '../transparent/registry-live';

let bundled: Registry | undefined;
const bundledRegistry = (): Registry =>
  (bundled ??= new ChainRegistryClient().bundled.get('penumbra-1'));

let live: Registry | undefined;
let refreshing: Promise<void> | undefined;

/**
 * Re-check the stored live registry and swap it in when it verifies; resolves
 * once later lookups will see it. Reads storage only, never the network -
 * the live copy itself only ever arrives via transparent/registry-live's
 * opt-in fetch, which this just picks up.
 */
export const refreshPenumbraRegistry = (): Promise<void> =>
  (refreshing ??= storedRegistryJson()
    .then(json => {
      if (json) {
        live = new Registry(json);
      }
    })
    .catch(() => undefined));

/** after a newer signed registry was stored: read it again on next refresh */
export const forgetPenumbraRegistry = () => {
  refreshing = undefined;
};

/** the registry zafu currently trusts for penumbra-1: live if stored and verified, else bundled */
export const penumbraRegistry = (): Registry => live ?? bundledRegistry();

/**
 * The registry's own metadata for `meta`'s asset id, when the registry knows
 * it. Undefined when `meta` carries no asset id, or the registry doesn't list
 * it (an unregistered IBC denom, an lp/auction nft, a delegation token, ...).
 */
export const registryMetadata = (meta?: Metadata): Metadata | undefined => {
  if (!meta?.penumbraAssetId?.inner.length) {
    return undefined;
  }
  try {
    return penumbraRegistry().tryGetMetadata(meta.penumbraAssetId);
  } catch {
    return undefined;
  }
};
