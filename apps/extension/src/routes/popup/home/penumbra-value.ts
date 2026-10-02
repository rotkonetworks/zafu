import { getMetadataFromBalancesResponse } from '@penumbra-zone/getters/balances-response';
import { getDisplayDenomFromView, getEquivalentValues } from '@penumbra-zone/getters/value-view';
import { asValueView } from '@penumbra-zone/getters/equivalent-value';
import { getDisplayDenomExponent } from '@penumbra-zone/getters/metadata';
import { bech32mAssetId } from '@penumbra-zone/bech32m/passet';
import { fromValueView } from '@penumbrafi/types/amount';
import { uint8ArrayToBase64 } from '@penumbrafi/types/base64';
import type { BalancesResponse } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import type { Metadata } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { filterFungibleBalances } from '../../../utils/is-fungible-asset';
import { symbolFromMetadata } from '../../../utils/asset-display';
import type { Local, Prices, Unit } from '../../../penumbra/price';
import { UM_ID, USDC_INJ_ID } from '../../../penumbra/quotes';

/** one fungible balance, as the home row and its sheet read it */
export interface Asset {
  key: string;
  base?: string;
  symbol: string;
  name: string;
  /** the staking token, the fallback figure when nothing has a price */
  um: boolean;
  amount: number;
  /** what the DEX prices it by: asset id and display exponent; absent for an unnamed asset */
  unit?: Unit;
  /** its price per display unit as the view service recorded it from recent batch swaps */
  local: Partial<Record<TotalIn, number>>;
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

const unitOf = (meta?: Metadata): Unit | undefined =>
  meta?.penumbraAssetId?.inner.length
    ? {
        id: uint8ArrayToBase64(meta.penumbraAssetId.inner),
        exponent: getDisplayDenomExponent.optional(meta) ?? 0,
      }
    : undefined;

const NUMERAIRE: Record<string, TotalIn> = { [USDC_INJ_ID]: 'usd', [UM_ID]: 'um' };

/** recorded prices per display unit, from the equivalent values the view service attaches */
const localOf = (b: BalancesResponse, amount: number) =>
  Object.fromEntries(
    amount > 0
      ? (getEquivalentValues.optional(b.balanceView) ?? []).flatMap(e => {
          const id = e.numeraire?.penumbraAssetId?.inner;
          const q = id?.length ? NUMERAIRE[uint8ArrayToBase64(id)] : undefined;
          return q ? [[q, Number(fromValueView(asValueView(e))) / amount]] : [];
        })
      : [],
  ) as Asset['local'];

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
    unit: unitOf(meta),
    local: localOf(b, amount),
    rawId: rawIdOf(b, base, meta?.symbol),
  };
};

/** staked, unbonding and open liquidity: held, but not a fungible row and not in the total */
const isPosition = (b: BalancesResponse) => {
  const display = b.balanceView ? getDisplayDenomFromView(b.balanceView) : '';
  return (
    /^(delegation_|unbonding_start_at_|lpnft_(opened|closed)_)/.test(display) &&
    Number(fromValueView(b.balanceView!)) > 0
  );
};

/**
 * The home's rows: fungible only, highest priority first, and how many
 * positions sit outside them. Module-level so react-query's select is stable.
 */
export const selectHome = (balances: BalancesResponse[]) => ({
  assets: filterFungibleBalances(balances)
    .sort((a, b) =>
      Number(
        (getMetadataFromBalancesResponse.optional(b)?.priorityScore ?? 0n) -
          (getMetadataFromBalancesResponse.optional(a)?.priorityScore ?? 0n),
      ),
    )
    .map(assetOf),
  positions: balances.filter(isPosition).length,
});

/** what the penumbra total is shown in (settings > networks > penumbra) */
export type TotalIn = 'usd' | 'um';

const sum = (xs: number[]) => xs.reduce((t, x) => t + x, 0);

/** an asset's price and worth in the quote; undefined when it has no route (or prices are not in) */
export const valueOf = (a: Asset, prices?: Prices) => {
  const price = a.unit && prices?.[a.unit.id];
  return price == null ? undefined : { price, value: a.amount * price };
};

/** the held assets' recorded prices, by asset id, for {@link combine} */
export const localPrices = (assets: Asset[]): Local<TotalIn> =>
  Object.fromEntries(assets.flatMap(a => (a.unit ? [[a.unit.id, a.local]] : [])));

/** held assets the DEX has no route for, left out of the total */
export const unpricedOf = (assets: Asset[], prices: Prices | undefined) =>
  prices ? assets.filter(a => a.amount > 0 && !valueOf(a, prices)) : [];

/**
 * The hero's figure: the worth of every priced asset in the chosen quote,
 * the rest left out (their rows say "no price"). With nothing priced it is
 * the UM held rather than a zero that would read as empty.
 */
export const heroOf = (
  assets: Asset[],
  prices: Prices | undefined,
  totalIn: TotalIn,
): { amount: number; unit: TotalIn } => {
  const values = assets.flatMap(a => valueOf(a, prices)?.value ?? []);
  return values.length
    ? { amount: sum(values), unit: totalIn }
    : { amount: sum(assets.filter(a => a.um).map(a => a.amount)), unit: 'um' };
};

const FMT: Record<TotalIn, Intl.NumberFormatOptions> = {
  usd: { style: 'currency', currency: 'USD' },
  um: { maximumFractionDigits: 2 },
};

/** the hero's figure in the quote, its unit shown beside it */
export const fmtFigure = (n: number, unit: TotalIn) => n.toLocaleString('en-US', FMT[unit]);

/** a row's worth or price in the quote: "$12.40", "12.4 um"; a price keeps four significant digits */
export const fmtIn = (n: number, unit: TotalIn, price = false) =>
  n.toLocaleString('en-US', { ...FMT[unit], ...(price && { maximumSignificantDigits: 4 }) }) +
  (unit === 'um' ? ' um' : '');

export const fmtAmount = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 6 });
