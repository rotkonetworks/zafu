/**
 * asset display helpers
 *
 * Resolve a human symbol for an asset without ever leaking a raw denom path
 * (e.g. `transfer/channel-2/uusdc`, `ibc/ABC...`, or a `passet1...` asset id) to
 * the user. Registry-known assets carry a real `symbol` in their metadata; for
 * everything else we degrade to a short, sanitized form.
 */

import type { Metadata } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { registryMetadata } from '../penumbra/asset-registry';

const IBC_HASH = /^[0-9a-f]{40,}$/i;

/**
 * Sanitize any denom / display / base string into a short human symbol. Never
 * returns a raw IBC path or hash - the last-resort fallback when no registry
 * metadata is available.
 */
export const shortSymbol = (input?: string): string => {
  if (!input) {
    return 'Unknown';
  }
  const s = input.trim();
  if (!s) {
    return 'Unknown';
  }
  // penumbra unknown asset id (bech32m) - opaque, show nothing meaningful
  if (s.startsWith('passet1')) {
    return 'Unknown';
  }
  // bare ibc denom: ibc/<hash> -> IBC-XXXX
  const ibc = /^ibc\/([0-9a-f]+)$/i.exec(s);
  if (ibc?.[1]) {
    return `IBC-${ibc[1].slice(0, 4).toUpperCase()}`;
  }
  // path denoms (transfer/channel-2/uusdc, factory/addr/token) -> last segment
  let seg = s.includes('/') ? (s.split('/').filter(Boolean).pop() ?? s) : s;
  // last segment is itself an opaque hash
  if (IBC_HASH.test(seg)) {
    return `IBC-${seg.slice(0, 4).toUpperCase()}`;
  }
  // strip the micro/nano SI prefix on cosmos base denoms: uusdc -> usdc
  if (/^u[a-z]/.test(seg)) {
    seg = seg.slice(1);
  }
  return seg.toUpperCase().slice(0, 12);
};

/**
 * Registry-first display metadata for `meta`'s asset: the registry's own
 * metadata when it knows the id (it may have renamed the asset since the view
 * service last saw it), else `meta` unchanged. Every symbol / name / image
 * path below reads from here, so a registry rename shows everywhere at once.
 */
export const displayMetadata = (meta?: Metadata): Metadata | undefined =>
  registryMetadata(meta) ?? meta;

/**
 * Symbol for a penumbra asset from its metadata. Registry-first: the
 * registry's symbol when it knows the asset id, then the view service's own
 * symbol, then a sanitized display / base - never the raw path.
 */
export const symbolFromMetadata = (meta?: Metadata): string => {
  const m = displayMetadata(meta);
  if (!m) {
    return 'Unknown';
  }
  if (m.symbol) {
    return m.symbol;
  }
  // display and base can be raw paths for unregistered IBC assets
  return shortSymbol(m.display || m.base);
};

/**
 * Name for a penumbra asset from its metadata. Registry-first, same as
 * {@link symbolFromMetadata}; falls back to the resolved symbol when neither
 * the registry nor the view service names it.
 */
export const nameFromMetadata = (meta?: Metadata): string => {
  const m = displayMetadata(meta);
  return m?.name || symbolFromMetadata(meta);
};
