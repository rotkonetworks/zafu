/**
 * What an asset on a transparent chain is: symbol and decimals, and whether it
 * can be shielded into Penumbra.
 *
 * "Shieldable" = the asset has come over the chain's Penumbra channel: the
 * Penumbra registry lists it as `transfer/<penumbra-side channel>/<denom>`.
 * Read from the registry BUNDLED in the extension - no network call. The
 * chain's own native and gas assets are known from its config.
 */

import { ChainRegistryClient } from '@penumbrafi/registry';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';

export interface TransparentAsset {
  /** the denom as the chain's bank module spells it */
  denom: string;
  symbol: string;
  decimals: number;
  /** Penumbra accepts it over the chain's channel */
  shieldable: boolean;
}

export interface HeldAsset extends TransparentAsset {
  amount: bigint;
}

const registryCache = new Map<string, Map<string, TransparentAsset>>();

/** assets Penumbra accepts over `penumbraChannel` (penumbra side), by lower-cased denom */
function registryAssets(penumbraChannel: string): Map<string, TransparentAsset> {
  const cached = registryCache.get(penumbraChannel);
  if (cached) {
    return cached;
  }
  const out = new Map<string, TransparentAsset>();
  try {
    const prefix = `transfer/${penumbraChannel}/`;
    const registry = new ChainRegistryClient().bundled.get('penumbra-1');
    for (const m of registry.getAllAssets()) {
      if (!m.base.startsWith(prefix)) {
        continue;
      }
      const denom = m.base.slice(prefix.length);
      const exponent = m.denomUnits.find(u => u.denom === m.display)?.exponent ?? 0;
      out.set(denom.toLowerCase(), {
        denom,
        symbol: m.symbol || denom,
        decimals: exponent,
        shieldable: true,
      });
    }
  } catch (err) {
    console.warn('[transparent] could not read the bundled registry', err);
  }
  registryCache.set(penumbraChannel, out);
  return out;
}

/**
 * Penumbra-native assets as they land on a chain after leaving Penumbra (an
 * unshield). IBC denoms are opaque hashes, so the ones we ship are listed.
 */
const RETURNING_ASSETS: Partial<Record<CosmosChainId, TransparentAsset[]>> = {
  noble: [
    {
      denom: 'ibc/955A03D0BC92B11738A1E4B0C9F2AAF05B79929703F907D2D7AF5A0D405AE8C1',
      symbol: 'UM',
      decimals: 6,
      shieldable: true,
    },
  ],
};

/** every asset on `chainId` we know the decimals of, by lower-cased denom */
export function knownAssets(chainId: CosmosChainId): Map<string, TransparentAsset> {
  const cfg = COSMOS_CHAINS[chainId];
  const out = new Map(
    cfg.penumbraSourceChannel ? registryAssets(cfg.penumbraSourceChannel) : undefined,
  );
  const add = (a: { denom: string; symbol: string; decimals: number }) => {
    const k = a.denom.toLowerCase();
    if (!out.has(k)) {
      out.set(k, { ...a, shieldable: false });
    }
  };
  for (const r of RETURNING_ASSETS[chainId] ?? []) {
    out.set(r.denom.toLowerCase(), r);
  }
  add({ denom: cfg.denom, symbol: cfg.symbol, decimals: cfg.decimals });
  if (cfg.gasAsset) {
    add(cfg.gasAsset);
  }
  return out;
}

/**
 * Known assets in `balances` with a non-zero amount: the chain's ramp asset
 * (config `denom`) first, then by symbol. Unknown denoms are left out - with
 * no decimals they can't be shown or moved safely.
 */
export function heldAssets(
  chainId: CosmosChainId,
  balances: readonly { denom: string; amount: bigint }[],
): HeldAsset[] {
  const known = knownAssets(chainId);
  const out: HeldAsset[] = [];
  for (const b of balances) {
    const meta = known.get(b.denom.toLowerCase());
    if (meta && b.amount > 0n) {
      // the bank's spelling, not the registry's: a transfer must name the
      // denom exactly as the account holds it
      out.push({ ...meta, denom: b.denom, amount: b.amount });
    }
  }
  const prefer = COSMOS_CHAINS[chainId].denom.toLowerCase();
  return out.sort((a, b) =>
    a.denom.toLowerCase() === prefer
      ? -1
      : b.denom.toLowerCase() === prefer
        ? 1
        : a.symbol.localeCompare(b.symbol),
  );
}

/** per-asset totals across addresses, same order rules */
export function totalHeld(
  chainId: CosmosChainId,
  perAddress: readonly (readonly { denom: string; amount: bigint }[])[],
): HeldAsset[] {
  const sum = new Map<string, { denom: string; amount: bigint }>();
  for (const list of perAddress) {
    for (const b of list) {
      const k = b.denom.toLowerCase();
      const prev = sum.get(k);
      sum.set(k, { denom: prev?.denom ?? b.denom, amount: (prev?.amount ?? 0n) + b.amount });
    }
  }
  return heldAssets(chainId, [...sum.values()]);
}

/**
 * Base units -> human string for display (no float math). Trims trailing zeros
 * and caps the fraction at maxFrac; a real balance too small to show never
 * reads as zero.
 */
export function formatBaseUnits(amount: bigint, decimals: number, maxFrac = decimals): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const frac = (amount % divisor)
    .toString()
    .padStart(decimals, '0')
    .slice(0, maxFrac)
    .replace(/0+$/, '');
  const shown = frac ? `${whole}.${frac}` : `${whole}`;
  return amount > 0n && shown === '0' ? `<0.${'0'.repeat(Math.max(0, maxFrac - 1))}1` : shown;
}

/**
 * Base units -> full-precision decimal string (for Max). Round-trips exactly
 * through parseAmountToBaseUnits.
 */
export function fullDecimalString(amount: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const frac = (amount % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
