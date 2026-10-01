import { describe, expect, test } from 'vitest';
import { BalancesResponse } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import {
  AssetId,
  DenomUnit,
  EquivalentValue,
  Metadata,
  ValueView,
} from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { Amount } from '@penumbra-zone/protobuf/penumbra/core/num/v1/num_pb';
import { base64ToUint8Array } from '@rotko/penumbra-types/base64';
import { USDC_INJ, heroOf, selectAssets } from './penumbra-value';

const meta = (base: string, symbol: string, display: string, exponent: number, id?: string) =>
  new Metadata({
    penumbraAssetId: id ? new AssetId({ inner: base64ToUint8Array(id) }) : undefined,
    base,
    display,
    symbol,
    name: symbol,
    denomUnits: [
      new DenomUnit({ denom: base, exponent: 0 }),
      new DenomUnit({ denom: display, exponent }),
    ],
  });

const UM = meta('upenumbra', 'UM', 'penumbra', 6);
const USDC = meta(
  USDC_INJ,
  'USDC.inj',
  'transfer/channel-18/usdc',
  6,
  '16ztCNRCyQZYu3cNN7DNMevUt0v2pERpUBflNfwP+wc=',
);
// the same numeraire as the view service may describe it: the id, a base spelled differently
const USDC_BY_ID = meta(
  'transfer/channel-18/erc20:0xA00C59FF5A080D2B954D0C75E46E22A0C371235A',
  'USDC.inj',
  'transfer/channel-18/usdc',
  6,
  '16ztCNRCyQZYu3cNN7DNMevUt0v2pERpUBflNfwP+wc=',
);
const OSMO = meta('transfer/channel-4/uosmo', 'OSMO', 'transfer/channel-4/osmo', 6);
const NOBLE = meta('transfer/channel-2/uusdc', 'USDC', 'transfer/channel-2/usdc', 6);

const balance = (m: Metadata, units: number, worth: [Metadata, number][] = []) =>
  new BalancesResponse({
    balanceView: new ValueView({
      valueView: {
        case: 'knownAssetId',
        value: {
          amount: new Amount({ lo: BigInt(units * 1e6), hi: 0n }),
          metadata: m,
          equivalentValues: worth.map(
            ([n, v]) =>
              new EquivalentValue({
                numeraire: n,
                equivalentAmount: new Amount({ lo: BigInt(v * 1e6), hi: 0n }),
              }),
          ),
        },
      },
    }),
  });

describe('penumbra portfolio value', () => {
  test('sums what has a route to usdc.inj, counts usdc.inj 1:1, leaves the rest out', () => {
    const assets = selectAssets([
      balance(UM, 10, [
        [NOBLE, 41],
        [USDC_BY_ID, 40],
      ]),
      balance(USDC, 5),
      balance(OSMO, 3, [[NOBLE, 1]]),
    ]);
    expect(assets.map(a => [a.symbol, a.usd])).toEqual([
      ['UM', 40],
      ['USDC.inj', 5],
      ['OSMO', undefined],
    ]);
    expect(heroOf(assets, 'usd')).toEqual({ amount: 45, unit: 'usd' });
    // 45 dollars at 4 dollars an um
    expect(heroOf(assets, 'um')).toEqual({ amount: 11.25, unit: 'um' });
  });

  test('falls back to the um held when nothing has a price', () => {
    const assets = selectAssets([balance(UM, 2.5), balance(OSMO, 3)]);
    expect(heroOf(assets, 'usd')).toEqual({ amount: 2.5, unit: 'um' });
  });

  test('stays in dollars when um itself has no price', () => {
    expect(heroOf(selectAssets([balance(USDC, 7)]), 'um')).toEqual({ amount: 7, unit: 'usd' });
  });
});
