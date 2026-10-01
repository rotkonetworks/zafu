import { getMetadataFromBalancesResponse } from '@penumbra-zone/getters/balances-response';
import { getDisplayDenomFromView, getEquivalentValues } from '@penumbra-zone/getters/value-view';
import { asValueView } from '@penumbra-zone/getters/equivalent-value';
import { bech32mAssetId } from '@penumbra-zone/bech32m/passet';
import { fromValueView } from '@rotko/penumbra-types/amount';
import type { BalancesResponse } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { filterFungibleBalances } from '../../../utils/is-fungible-asset';
import { symbolFromMetadata } from '../../../utils/asset-display';

/**
 * USDC bridged from Injective, the first numeraire of the bundled
 * @penumbrafi/registry for penumbra-1. The home values the portfolio in it:
 * the view service records each asset's price against its numeraires from
 * the DEX batch swaps in the blocks it already syncs, so a value costs no
 * request of its own and no third party ever sees what is held.
 */
export const USDC_INJ = 'transfer/channel-18/erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a';

/** one fungible balance, as the home row and its sheet read it */
export interface Asset {
  key: string;
  base?: string;
  symbol: string;
  name: string;
  /** the staking token, the fallback figure when nothing has a price */
  um: boolean;
  amount: number;
  /** its worth in USDC.inj on the penumbra DEX; undefined when it has no route */
  usd?: number;
  /** the identifier of an asset with no registry symbol, to look it up */
  rawId?: string;
}

const rawIdOf = (b: BalancesResponse, base?: string, symbol?: string) => {
  const vv = b.balanceView?.valueView;
  if (vv?.case === 'unknownAssetId' && vv.value.assetId) {
    try {
      return bech32mAssetId(vv.value.assetId);
    } catch {
      return undefined;
    }
  }
  return symbol ? undefined : base;
};

const usdOf = (b: BalancesResponse, base: string | undefined, amount: number) => {
  if (base === USDC_INJ) {
    return amount;
  }
  const eq = getEquivalentValues.optional(b.balanceView)?.find(e => e.numeraire?.base === USDC_INJ);
  return eq && Number(fromValueView(asValueView(eq)));
};

const assetOf = (b: BalancesResponse, i: number): Asset => {
  const meta = getMetadataFromBalancesResponse.optional(b);
  const base = typeof meta?.base === 'string' ? meta.base : undefined;
  const symbol = symbolFromMetadata(meta);
  const amount = b.balanceView ? Number(fromValueView(b.balanceView)) : 0;
  return {
    key: base ?? String(i),
    base,
    symbol,
    name: meta?.name || symbol,
    um: ['penumbra', 'UM'].includes(b.balanceView ? getDisplayDenomFromView(b.balanceView) : ''),
    amount,
    usd: usdOf(b, base, amount),
    rawId: rawIdOf(b, base, meta?.symbol),
  };
};

/** fungible only, highest priority first; module-level so react-query's select is stable */
export const selectAssets = (balances: BalancesResponse[]): Asset[] =>
  filterFungibleBalances(balances)
    .sort((a, b) =>
      Number(
        (getMetadataFromBalancesResponse.optional(b)?.priorityScore ?? 0n) -
          (getMetadataFromBalancesResponse.optional(a)?.priorityScore ?? 0n),
      ),
    )
    .map(assetOf);

/** what the penumbra total is shown in (settings > networks > penumbra) */
export type TotalIn = 'usd' | 'um';

const sum = (xs: number[]) => xs.reduce((t, x) => t + x, 0);

/**
 * The hero's figure: the dollar total of every asset with a route to
 * USDC.inj (the rest are left out and say "no price" on their row), or that
 * total in UM at UM's own USDC.inj price. With nothing priced it is the UM
 * held; with UM unpriced it stays in dollars rather than guess.
 */
export const heroOf = (assets: Asset[], totalIn: TotalIn): { amount: number; unit: TotalIn } => {
  const priced = assets.filter(a => a.usd !== undefined);
  if (priced.length === 0) {
    return { amount: sum(assets.filter(a => a.um).map(a => a.amount)), unit: 'um' };
  }
  const usd = sum(priced.map(a => a.usd!));
  const um = priced.find(a => a.um && a.amount > 0);
  return totalIn === 'um' && um
    ? { amount: usd / (um.usd! / um.amount), unit: 'um' }
    : { amount: usd, unit: 'usd' };
};

export const fmtAmount = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 6 });

export const fmtUsd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
