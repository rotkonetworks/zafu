/**
 * The penumbra asset registry zafu currently trusts for display, for the
 * chain in use: on penumbra-1 the stored signed live copy when one verifies
 * (transparent/registry-live), else the bundled copy; on a testnet the
 * bundled copy for its chain id, or none, so its assets show by their own
 * denoms and never as a mainnet asset that shares an id. Read-only, never
 * touches the network.
 *
 * This is the one place every symbol/name/image path reads from, so a
 * registry rename (e.g. `axlUSDT` -> `USDT.axl`) shows on the Penumbra home
 * row, the token sheet, the send/swap pickers and history all at once,
 * instead of each screen carrying its own stale copy of the view service's
 * metadata.
 */

import { useSyncExternalStore } from 'react';
import { Registry } from '@penumbrafi/registry';
import type { Metadata } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { registryOf } from '@repo/context/registry-client';
import { storedRegistryJson } from '../transparent/registry-live';
import { readPenumbraChain } from './active-chain';
import { PENUMBRA_CHAINS, PENUMBRA_MAINNET } from './chain';

const bundled = new Map<string, Registry>();
const bundledRegistry = (chainId: string): Registry => {
  let r = bundled.get(chainId);
  if (!r) {
    r = registryOf(chainId);
    bundled.set(chainId, r);
  }
  return r;
};

let live: Registry | undefined;
let refreshing: Promise<void> | undefined;

/** the chain in use as last read: mainnet until storage says otherwise, '' for a testnet not yet named */
let chain = PENUMBRA_MAINNET;
const listeners = new Set<() => void>();

const readChain = () =>
  readPenumbraChain()
    .then(({ chainId = '' }) => {
      if (chainId !== chain) {
        chain = chainId;
        listeners.forEach(l => l());
      }
    })
    .catch(() => undefined);

try {
  const keys = ['enabledNetworks', ...Object.values(PENUMBRA_CHAINS).map(c => c.params)];
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && keys.some(k => k in changes)) {
      void readChain();
    }
  });
} catch {
  // no extension storage (tests): mainnet stands
}

/** the penumbra chain id in use, as last read ('' for a testnet no node has named yet) */
export const penumbraChainId = (): string => chain;

/** call `l` whenever the chain in use changes; returns the unsubscribe */
export const onPenumbraChainChange = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** the chain id in use, re-rendering when it changes */
export const usePenumbraChainId = () =>
  useSyncExternalStore(onPenumbraChainChange, penumbraChainId);

/**
 * Re-read the chain in use and the stored live registry, swapping it in when
 * it verifies; resolves once later lookups will see both. Reads storage only,
 * never the network - the live copy itself only ever arrives via
 * transparent/registry-live's opt-in fetch, which this just picks up.
 */
export const refreshPenumbraRegistry = (): Promise<void> =>
  (refreshing ??= Promise.all([
    readChain(),
    storedRegistryJson().then(json => {
      if (json) {
        live = new Registry(json);
      }
    }),
  ])
    .then(() => undefined)
    .catch(() => undefined));

/** after a newer signed registry was stored: read it again on next refresh */
export const forgetPenumbraRegistry = () => {
  refreshing = undefined;
};

/** the registry zafu currently trusts for the chain in use (see above) */
export const penumbraRegistry = (): Registry =>
  live?.chainId === chain ? live : bundledRegistry(chain);

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
