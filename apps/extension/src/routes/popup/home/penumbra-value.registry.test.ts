/**
 * The registry-first fix, end to end, against the real bundled registry - no
 * mocking of ../../../penumbra/asset-registry here (see penumbra-value.test.ts
 * for the mocked unit test). Proves `symbolFromMetadata` / `nameFromMetadata`
 * actually key into `Registry.tryGetMetadata` by the real `AssetId`, not just
 * that the seam is wired up.
 */
import { describe, expect, test } from 'vitest';
import { ChainRegistryClient } from '@penumbrafi/registry';
import { BalancesResponse } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import {
  Denom,
  Metadata,
  ValueView,
} from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { Amount } from '@penumbra-zone/protobuf/penumbra/core/num/v1/num_pb';
import { selectHome } from './penumbra-value';

describe('registry-first display (real bundled registry)', () => {
  test('an exchange-style view service symbol/name is overridden by the registry rename', () => {
    // the bundled penumbrafi registry currently names this bridged asset
    // axlUSDT ("Tether USD"); a soon-to-ship release renames it USDT.axl -
    // whichever it is, the view's stale metadata must not win.
    const registry = new ChainRegistryClient().bundled.get('penumbra-1');
    const known = registry.tryGetMetadata(new Denom({ denom: 'transfer/channel-24/uusdt' }));
    expect(known).toBeDefined();
    expect(known!.penumbraAssetId?.inner.length).toBeGreaterThan(0);

    // the view service hasn't caught up: no symbol, and the exchange-style name
    const viewMeta = new Metadata({
      penumbraAssetId: known!.penumbraAssetId,
      base: known!.base,
      display: known!.display,
      denomUnits: known!.denomUnits,
      symbol: '',
      name: 'Tether USDT',
    });
    const balance = new BalancesResponse({
      balanceView: new ValueView({
        valueView: {
          case: 'knownAssetId',
          value: { amount: new Amount({ lo: 1_000_000n, hi: 0n }), metadata: viewMeta },
        },
      }),
    });

    const [asset] = selectHome([balance]).assets;
    expect(asset!.symbol).toBe(known!.symbol);
    expect(asset!.name).toBe(known!.name);
    expect(asset!.base).toBe('transfer/channel-24/uusdt');
  });
});
