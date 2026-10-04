import { describe, expect, test, vi } from 'vitest';
import { BalancesResponse } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import {
  AssetId,
  DenomUnit,
  Metadata,
  ValueView,
} from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { Amount } from '@penumbra-zone/protobuf/penumbra/core/num/v1/num_pb';
import { base64ToUint8Array } from '@penumbrafi/types/base64';
import { EquivalentValue } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import {
  fmtIn,
  heroOf,
  LOCAL_PRICE_MAX_AGE_BLOCKS,
  localPrices,
  selectHome,
  valueOf,
} from './penumbra-value';
import { combine, fixedBook, type Simulate } from '../../../penumbra/price';
import { QUOTES, UNIVERSE } from '../../../penumbra/quotes';

vi.mock('../../../penumbra/asset-registry', () => ({ registryMetadata: vi.fn() }));
import { registryMetadata } from '../../../penumbra/asset-registry';

const selectAssets = (b: BalancesResponse[]) => selectHome(b).assets;

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

const UM_ID = 'KeqcLzNx9qSH5+lcJHBB9KNW+YPrBk5dKzvPMiypahA=';
const USDC_ID = '16ztCNRCyQZYu3cNN7DNMevUt0v2pERpUBflNfwP+wc=';
const OSMO_ID = 'W4rFTMJQgSPxQ2zgxLbKCaLm7Of+aWpVR1kd0SDAvEk=';
const UM = meta('upenumbra', 'UM', 'penumbra', 6, UM_ID);
const USDC = meta(
  'transfer/channel-18/erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a',
  'USDC.inj',
  'transfer/channel-18/usdc',
  6,
  USDC_ID,
);
const OSMO = meta('transfer/channel-20/uosmo', 'OSMO', 'transfer/channel-20/osmo', 6, OSMO_ID);
const ETH = meta(
  'transfer/channel-20/wei',
  'allETH',
  'transfer/channel-20/eth',
  18,
  OSMO_ID.replace('W', 'X'),
);
const NOBLE_ID = 'drPksQaBNYwSOzgfkGOEdrd4kEDkeALeh58Ps+7cjQs=';
const NOBLE = meta('transfer/channel-2/uusdc', 'USDC', 'transfer/channel-2/usdc', 6, NOBLE_ID);
const DELEGATION = meta(
  'udelegation_penumbravalid1abc',
  'delUM(x)',
  'delegation_penumbravalid1abc',
  6,
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
);
const UNNAMED = meta('transfer/channel-20/unknown', '', 'transfer/channel-20/unknown', 6);

const balance = (m: Metadata, units: bigint, worth: [Metadata, bigint][] = [], asOfHeight = 0n) =>
  new BalancesResponse({
    balanceView: new ValueView({
      valueView: {
        case: 'knownAssetId',
        value: {
          amount: new Amount({ lo: units, hi: 0n }),
          metadata: m,
          equivalentValues: worth.map(
            ([n, v]) =>
              new EquivalentValue({
                numeraire: n,
                equivalentAmount: new Amount({ lo: v, hi: 0n }),
                asOfHeight,
              }),
          ),
        },
      },
    }),
  });

describe('penumbra portfolio value', () => {
  const assets = selectAssets([
    balance(UM, 10_000_000n),
    balance(USDC, 5_000_000n),
    balance(OSMO, 3_000_000n),
  ]);

  test('reads each asset by its id and registry exponent', () => {
    expect(assets.map(a => [a.symbol, a.amount, a.unit])).toEqual([
      ['UM', 10, { id: UM_ID, exponent: 6 }],
      ['USDC.inj', 5, { id: USDC_ID, exponent: 6 }],
      ['OSMO', 3, { id: OSMO_ID, exponent: 6 }],
    ]);
    const [eth] = selectAssets([balance(ETH, 2n * 10n ** 18n)]);
    expect([eth!.amount, eth!.unit?.exponent]).toEqual([2, 18]);
  });

  test('sums the priced assets in the quote and leaves the unrouted out', () => {
    const prices = { [USDC_ID]: 1, [UM_ID]: 4, [OSMO_ID]: null };
    expect(heroOf(assets, prices, 'usd')).toEqual({ amount: 45, unit: 'usd' });
    expect(valueOf(assets[2]!, prices)).toBeUndefined();
    expect(valueOf(assets[0]!, prices)).toEqual({ price: 4, value: 40 });
  });

  test('sums in um the same way', () => {
    const prices = { [UM_ID]: 1, [USDC_ID]: 0.25, [OSMO_ID]: 5 };
    expect(heroOf(assets, prices, 'um')).toEqual({ amount: 26.25, unit: 'um' });
  });

  test('falls back to the um held while nothing has a price', () => {
    expect(heroOf(assets, undefined, 'usd')).toEqual({ amount: 10, unit: 'um' });
    expect(heroOf(assets, {}, 'usd')).toEqual({ amount: 10, unit: 'um' });
  });

  test('an asset with no id has no price', () => {
    const [unnamed] = selectAssets([balance(UNNAMED, 1_000_000n)]);
    expect(unnamed!.unit).toBeUndefined();
    expect(valueOf(unnamed!, { [USDC_ID]: 1 })).toBeUndefined();
  });

  test('formats worth and price in the quote', () => {
    expect(fmtIn(1034.614, 'usd')).toBe('$1,034.61');
    expect(fmtIn(0.006612, 'usd', true)).toBe('$0.006612');
    expect(fmtIn(152.404697, 'um', true)).toBe('152.4 um');
    expect(fmtIn(26.25, 'um')).toBe('26.25 um');
  });

  test('reads the recorded price per display unit against um and usdc.inj, by id', () => {
    const [osmo] = selectAssets([
      balance(OSMO, 4_000_000n, [
        [USDC, 130_000n],
        [UM, 20_000_000n],
        [NOBLE, 140_000n],
      ]),
    ]);
    expect(osmo!.local).toEqual({ usd: 0.0325, um: 5 });
  });

  test('prices 100 noble usdc through the dex, not as usdc.inj 1:1, and the total is the rows', async () => {
    // display-unit rates on the dex; noble usdc trades a little over par, osmo has no route
    const rates: Record<string, number> = {
      [`${NOBLE_ID}>${USDC_ID}`]: 1.0203,
      [`${NOBLE_ID}>${UM_ID}`]: 152.4,
      [`${UM_ID}>${USDC_ID}`]: 0.006612,
      [`${USDC_ID}>${UM_ID}`]: 149.4,
    };
    const simulate: Simulate = async (from, to, amount) => {
      const r = rates[`${from.id}>${to.id}`];
      const out = (Number(amount) / 10 ** from.exponent) * (r ?? 0) * 10 ** to.exponent;
      return { filled: r ? amount : 0n, out: BigInt(Math.round(out)) };
    };
    const { assets, positions } = selectHome([
      balance(NOBLE, 100_000_000n),
      balance(UM, 250_000_000n),
      balance(USDC, 5_000_000n),
      balance(OSMO, 3_000_000n),
      balance(DELEGATION, 7_000_000n),
    ]);
    expect(positions).toBe(1);
    expect(assets.map(a => a.symbol).sort()).toEqual(['OSMO', 'UM', 'USDC', 'USDC.inj']);

    const fixed = await fixedBook(simulate, UNIVERSE, QUOTES)();
    const book = combine(QUOTES, localPrices(assets), fixed);

    const noble = assets.find(a => a.unit?.id === NOBLE_ID)!;
    expect(valueOf(noble, book.usd)?.value).toBeCloseTo(102.03, 6);
    const rows = assets.flatMap(a => valueOf(a, book.usd)?.value ?? []);
    const hero = heroOf(assets, book.usd, 'usd');
    expect(hero.amount).toBeCloseTo(
      rows.reduce((t, x) => t + x, 0),
      9,
    );
    expect(hero.amount).toBeCloseTo(102.03 + 250 * 0.006612 + 5, 6);
    // an asset with no route is left out of the total
    expect(valueOf(assets.find(a => a.symbol === 'OSMO')!, book.usd)).toBeUndefined();

    expect(heroOf(assets, book.um, 'um').amount).toBeCloseTo(100 * 152.4 + 250 + 5 * 149.4, 6);
  });

  test('two wallets with different holdings send the node the identical query list', async () => {
    const pass = async (balances: BalancesResponse[]) => {
      const sent: string[] = [];
      const simulate: Simulate = async (from, to, amount) => {
        sent.push(`${from.id}>${to.id}:${amount}`);
        return { filled: 0n, out: 0n };
      };
      const { assets } = selectHome(balances);
      combine(QUOTES, localPrices(assets), await fixedBook(simulate, UNIVERSE, QUOTES)());
      return sent;
    };
    const a = await pass([balance(NOBLE, 100_000_000n), balance(UM, 1n)]);
    const b = await pass([balance(OSMO, 3_000_000n), balance(ETH, 5n * 10n ** 18n)]);
    expect(a).toEqual(b);
    expect(a).toHaveLength(2 * UNIVERSE.length - 2);
    expect(a.some(q => q.includes(':5000000000000000000'))).toBe(false);
  });
});

describe('recorded prices', () => {
  test('a numeraire without display units still prices in dollars, not base units', () => {
    // the view service's numeraire metadata with no denom units: exponent would read as 0
    const bareUsdc = new Metadata({ penumbraAssetId: USDC.penumbraAssetId });
    const [usdt] = selectAssets([balance(OSMO, 20_000_000n, [[bareUsdc, 18_800_000n]])]);
    expect(usdt!.local['usd']).toBeCloseTo(0.94, 6);
  });
});

describe('registry-first display', () => {
  test('a registry rename overrides the view service symbol and name', () => {
    // the view service hasn't caught up to the registry's rename yet: no
    // symbol, and a name an exchange would use ("Tether USDT")
    const AXLUSDT_ID = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxA=';
    const viewOnly = meta('transfer/channel-24/uusdt', '', 'transfer/channel-24/usdt', 6);
    const usdtView = new Metadata({
      ...viewOnly,
      penumbraAssetId: new AssetId({ inner: base64ToUint8Array(AXLUSDT_ID) }),
      name: 'Tether USDT',
    });
    const usdtRegistry = new Metadata({
      ...meta('transfer/channel-24/uusdt', 'axlUSDT', 'transfer/channel-24/usdt', 6, AXLUSDT_ID),
      name: 'Tether USD',
    });
    vi.mocked(registryMetadata).mockImplementation(m =>
      m?.penumbraAssetId?.inner.length && m.penumbraAssetId.equals(usdtView.penumbraAssetId)
        ? usdtRegistry
        : undefined,
    );
    const [usdt] = selectAssets([balance(usdtView, 1_000_000n)]);
    expect(usdt!.symbol).toBe('axlUSDT');
    expect(usdt!.name).toBe('Tether USD');
    vi.mocked(registryMetadata).mockReset();
  });
});

describe('recorded prices expire', () => {
  const at = 1_000_000;
  const osmoAt = (h: number) =>
    selectAssets([balance(OSMO, 2_000_000n, [[USDC, 3_000_000n]], BigInt(h))]);

  test('a price recorded within the window is used', () => {
    const local = localPrices(osmoAt(at - LOCAL_PRICE_MAX_AGE_BLOCKS), at);
    expect(local[OSMO_ID]?.usd).toBeCloseTo(1.5, 9);
  });

  test('an older one is dropped, so the dex pass prices the asset instead', () => {
    expect(localPrices(osmoAt(at - LOCAL_PRICE_MAX_AGE_BLOCKS - 1), at)[OSMO_ID]).toEqual({});
  });

  test('a price at no known height is dropped once the height is known', () => {
    expect(localPrices(osmoAt(0), at)[OSMO_ID]).toEqual({});
  });
});
