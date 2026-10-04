/**
 * Harness-only: the board's three assets (HomePenumbra), so the home can be
 * shot next to it on a wallet that holds nothing. `?fixture=1`, unpacked only.
 */

import type { Book } from '../../../penumbra/price';
import type { Asset, TotalIn } from './penumbra-value';

const asset = (symbol: string, name: string, amount: number, um = false): Asset => ({
  key: symbol,
  base: `u${symbol}`,
  symbol: symbol.toUpperCase(),
  name,
  um,
  amount,
  unit: { id: symbol, exponent: 6 },
  local: {},
});

export const homeFixture = (): { assets: Asset[]; book: Book<TotalIn> } | undefined =>
  new URLSearchParams(location.search).get('fixture') === '1' &&
  !chrome.runtime.getManifest().update_url
    ? {
        assets: [
          asset('um', 'penumbra', 248.5, true),
          asset('usdc', 'usd coin', 1120),
          asset('osmo', 'osmosis', 62.3),
        ],
        book: {
          usd: { um: 1034.61 / 248.5, usdc: 1, osmo: 29.46 / 62.3 },
          um: { um: 1, usdc: 248.5 / 1034.61, osmo: 29.46 / 62.3 / (1034.61 / 248.5) },
        },
      }
    : undefined;
