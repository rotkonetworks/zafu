/**
 * Which Injective assets the user holds that Penumbra accepts.
 *
 * "Accepted" = the asset has come over the Injective <-> Penumbra channel: the
 * Penumbra registry lists it as `transfer/<penumbra-side channel>/<injective
 * denom>`. Read from the registry BUNDLED in the extension - no network call.
 */

import { ChainRegistryClient } from '@penumbrafi/registry';

export interface InjectiveAsset {
  /** the denom on Injective, as the bank module spells it */
  denom: string;
  symbol: string;
  decimals: number;
}

export interface HeldAsset extends InjectiveAsset {
  amount: bigint;
}

let cache: Map<string, InjectiveAsset> | undefined;

/**
 * Accepted assets keyed by lower-cased Injective denom. `penumbraChannel` is
 * the channel on the PENUMBRA side (channel-18 for Injective).
 */
export function acceptedInjectiveAssets(penumbraChannel: string): Map<string, InjectiveAsset> {
  if (cache) {
    return cache;
  }
  const out = new Map<string, InjectiveAsset>();
  try {
    const prefix = `transfer/${penumbraChannel}/`;
    const registry = new ChainRegistryClient().bundled.get('penumbra-1');
    for (const m of registry.getAllAssets()) {
      if (!m.base.startsWith(prefix)) {
        continue;
      }
      const denom = m.base.slice(prefix.length);
      const exponent = m.denomUnits.find(u => u.denom === m.display)?.exponent ?? 0;
      out.set(denom.toLowerCase(), { denom, symbol: m.symbol || denom, decimals: exponent });
    }
  } catch (err) {
    console.warn('[injective] could not read the bundled registry', err);
  }
  cache = out;
  return out;
}

/**
 * Accepted assets in `balances` with a non-zero amount: `prefer` (USDC.inj)
 * first, then by symbol. Unknown denoms are left out - their decimals are
 * unknown and Penumbra would not recognise them.
 */
export function heldAcceptedAssets(
  balances: readonly { denom: string; amount: bigint }[],
  accepted: ReadonlyMap<string, InjectiveAsset>,
  prefer: string,
): HeldAsset[] {
  const out: HeldAsset[] = [];
  for (const b of balances) {
    const meta = accepted.get(b.denom.toLowerCase());
    if (meta && b.amount > 0n) {
      out.push({ ...meta, amount: b.amount });
    }
  }
  const p = prefer.toLowerCase();
  return out.sort((a, b) =>
    a.denom.toLowerCase() === p
      ? -1
      : b.denom.toLowerCase() === p
        ? 1
        : a.symbol.localeCompare(b.symbol),
  );
}

/** per-asset totals across addresses, same order rules */
export function totalHeld(
  perAddress: readonly (readonly { denom: string; amount: bigint }[])[],
  accepted: ReadonlyMap<string, InjectiveAsset>,
  prefer: string,
): HeldAsset[] {
  const sum = new Map<string, bigint>();
  for (const list of perAddress) {
    for (const b of list) {
      const k = b.denom.toLowerCase();
      sum.set(k, (sum.get(k) ?? 0n) + b.amount);
    }
  }
  return heldAcceptedAssets(
    [...sum].map(([denom, amount]) => ({ denom, amount })),
    accepted,
    prefer,
  );
}
